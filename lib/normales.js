// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";

/**
 * Normales saisonnières 1991-2020 aux coordonnées de la commune.
 *
 * POURQUOI CE FICHIER EXISTE
 * --------------------------
 * L'app affichait autrefois un « écart aux normales » calculé sur deux tableaux
 * mensuels codés en dur, sans station de référence ni période citée. L'ADR-0022 les
 * a supprimés : « annoncer +6° au-dessus des normales à partir de valeurs non
 * sourcées serait une donnée inventée (ADR-0018), sur un sujet où l'habitant n'a
 * aucun moyen de vérifier ». Et : « reprise possible le jour où le backend servira
 * des normales sourcées ». C'est ce jour-là.
 *
 * CE QUE CE MODULE SERT — ET CE QU'IL NE PRÉTEND PAS ÊTRE
 * -------------------------------------------------------
 * La source est la **réanalyse ERA5** (ECMWF), servie par l'API archive
 * d'Open-Meteo, interrogée aux coordonnées de la commune sur les trente années
 * 1991-2020. Ce n'est **pas** une station Météo-France : c'est une maille de modèle.
 * Le payload le dit (`reanalyse: true`, `station: null`) et l'étiquette affichée
 * dans l'app le dit aussi, mot pour mot. Une normale de maille annoncée comme une
 * normale de station serait exactement la faute que l'ADR-0022 a corrigée.
 *
 * RÈGLE DU TOUT OU RIEN
 * ---------------------
 * Si un seul mois n'a pas assez de jours mesurés, `agregerNormales` lève : on ne
 * sert pas onze mois sur douze. L'app n'affiche alors aucun écart — c'est le
 * comportement d'aujourd'hui, et il est correct.
 */

const axios = require("axios");
const { OPEN_METEO_LAT, OPEN_METEO_LON, OPEN_METEO_TZ } = require("../config");
const { redisGet, redisSetex } = require("./redis");

const PERIODE = { debut: 1991, fin: 2020 };
const CLE_REDIS = "mat:meteo:normales:v1";
const TTL_REDIS_S = 180 * 24 * 3600;          // 6 mois : une normale trentenaire ne bouge pas
const COUVERTURE_MINIMALE = 0.8;              // 80 % des jours attendus, par mois

// Bornes de vraisemblance : une valeur hors de cet intervalle en Beauce n'est pas
// une mesure, c'est un défaut de lecture (unité, sentinelle, colonne décalée).
const TEMP_MIN_PLAUSIBLE = -40;
const TEMP_MAX_PLAUSIBLE = 60;

const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** Nombre de jours attendus pour un mois donné sur toute la période. */
function joursAttendus(mois, debut, fin) {
  let total = 0;
  for (let annee = debut; annee <= fin; annee++) {
    total += new Date(Date.UTC(annee, mois, 0)).getUTCDate();
  }
  return total;
}

function arrondi1(x) {
  return Math.round(x * 10) / 10;
}

/**
 * Agrège une série quotidienne en douze normales mensuelles.
 *
 * Fonction PURE : c'est elle qui porte la règle métier, donc elle est testable
 * sans réseau (`test/normales.test.js`).
 *
 * @param {{time:string[], temperature_2m_max:number[], temperature_2m_min:number[]}} daily
 * @param {{debut?:number, fin?:number, couvertureMinimale?:number}} options
 * @returns {Array<{mois:number, tmax:number, tmin:number, jours:number}>}
 * @throws si la série est inexploitable ou si un mois est trop lacunaire.
 */
function agregerNormales(daily, options = {}) {
  const debut = options.debut || PERIODE.debut;
  const fin = options.fin || PERIODE.fin;
  const couverture = options.couvertureMinimale != null ? options.couvertureMinimale : COUVERTURE_MINIMALE;

  const temps = (daily && daily.time) || null;
  const maxs = (daily && daily.temperature_2m_max) || null;
  const mins = (daily && daily.temperature_2m_min) || null;

  if (!Array.isArray(temps) || !Array.isArray(maxs) || !Array.isArray(mins)) {
    throw new Error("série quotidienne absente ou malformée");
  }
  if (temps.length !== maxs.length || temps.length !== mins.length) {
    throw new Error(`séries de longueurs différentes (${temps.length}/${maxs.length}/${mins.length})`);
  }
  if (temps.length === 0) throw new Error("série quotidienne vide");

  const cumul = Array.from({ length: 12 }, () => ({ sommeMax: 0, sommeMin: 0, jours: 0 }));

  for (let i = 0; i < temps.length; i++) {
    const jour = String(temps[i] || "");
    const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(jour);
    if (!m) continue;
    const annee = Number(m[1]);
    if (annee < debut || annee > fin) continue;

    // ⚠️ `Number(null)` vaut 0, pas NaN — et `Number("")` aussi. Un test de
    // finitude seul laisserait donc passer chaque jour manquant comme un 0 °C,
    // qui tirerait la normale vers le bas sans que rien ne le signale : la faute
    // exacte de `temperature_2m_max || 0`, corrigée en v4.78 (ADR-0022). Les
    // valeurs absentes sont donc écartées AVANT toute conversion.
    const brutMax = maxs[i];
    const brutMin = mins[i];
    if (brutMax == null || brutMin == null || brutMax === "" || brutMin === "") continue;

    const tmax = Number(brutMax);
    const tmin = Number(brutMin);
    if (!Number.isFinite(tmax) || !Number.isFinite(tmin)) continue;
    if (tmax < TEMP_MIN_PLAUSIBLE || tmax > TEMP_MAX_PLAUSIBLE) continue;
    if (tmin < TEMP_MIN_PLAUSIBLE || tmin > TEMP_MAX_PLAUSIBLE) continue;

    const idx = Number(m[2]) - 1;
    cumul[idx].sommeMax += tmax;
    cumul[idx].sommeMin += tmin;
    cumul[idx].jours += 1;
  }

  return cumul.map((c, idx) => {
    const attendus = joursAttendus(idx + 1, debut, fin);
    if (c.jours < attendus * couverture) {
      throw new Error(
        `mois ${idx + 1} trop lacunaire : ${c.jours} jours mesurés sur ${attendus} attendus`
      );
    }
    const tmax = arrondi1(c.sommeMax / c.jours);
    const tmin = arrondi1(c.sommeMin / c.jours);
    if (tmax < tmin) {
      throw new Error(`mois ${idx + 1} incohérent : maximale moyenne (${tmax}) sous la minimale (${tmin})`);
    }
    return { mois: idx + 1, tmax, tmin, jours: c.jours };
  });
}

/** Enveloppe servie à l'app : les valeurs ET leur provenance, indissociables. */
function construirePayload(mois, coordonnees) {
  return {
    periode: { debut: PERIODE.debut, fin: PERIODE.fin },
    jeu: "ERA5",
    fournisseur: "Open-Meteo",
    licence: "CC BY 4.0",
    // Ni station, ni relevé : une maille de réanalyse. Dit ici pour que l'app
    // n'ait pas à le deviner, et ne puisse pas prétendre autre chose.
    reanalyse: true,
    station: null,
    etiquette: `Normales ${PERIODE.debut}-${PERIODE.fin} — réanalyse ERA5 (Open-Meteo)`,
    coordonnees,
    mois,
    calculeLe: new Date().toISOString(),
  };
}

async function fetchArchiveEra5() {
  const url =
    `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${encodeURIComponent(OPEN_METEO_LAT)}` +
    `&longitude=${encodeURIComponent(OPEN_METEO_LON)}` +
    `&start_date=${PERIODE.debut}-01-01` +
    `&end_date=${PERIODE.fin}-12-31` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    // Jeu de données ÉPINGLÉ : l'étiquette affichée dit « ERA5 », elle doit rester
    // vraie même si le défaut d'Open-Meteo (`best_match`) change un jour.
    `&models=era5` +
    `&timezone=${encodeURIComponent(OPEN_METEO_TZ)}`;

  // Trente ans de valeurs quotidiennes : requête lourde, faite une fois par semestre.
  const r = await axios.get(url, { timeout: 60000 });
  return r.data;
}

let _normales = null;      // cache mémoire : une normale trentenaire ne change pas
let _enCours = null;       // requête en vol, pour ne pas la lancer deux fois
let _echecLe = 0;          // horodatage du dernier échec, pour ne pas marteler l'API

const DELAI_APRES_ECHEC_MS = 6 * 3600 * 1000; // 6 h

/** Normales déjà connues (mémoire ou Redis), ou `null`. Ne déclenche aucun calcul. */
async function lireNormales() {
  if (_normales) return _normales;
  try {
    const stockees = await redisGet(CLE_REDIS);
    if (stockees && Array.isArray(stockees.mois) && stockees.mois.length === 12) {
      _normales = stockees;
      return _normales;
    }
  } catch (_) {
    // Redis en mode dégradé (429 Upstash) : on n'en fait pas une panne.
  }
  return null;
}

/**
 * Calcule les normales si elles manquent. Une seule requête en vol à la fois ;
 * après un échec, on attend six heures avant de réessayer.
 * Renvoie le payload ou `null` — ne lève jamais.
 */
async function calculerNormales() {
  if (_normales) return _normales;
  if (_enCours) return _enCours;
  if (_echecLe && Date.now() - _echecLe < DELAI_APRES_ECHEC_MS) return null;

  _enCours = (async () => {
    try {
      const data = await fetchArchiveEra5();
      const mois = agregerNormales(data && data.daily);
      const payload = construirePayload(mois, {
        lat: Number(OPEN_METEO_LAT),
        lon: Number(OPEN_METEO_LON),
        altitude: data && Number.isFinite(Number(data.elevation)) ? Number(data.elevation) : null,
      });
      _normales = payload;
      _echecLe = 0;
      await redisSetex(CLE_REDIS, TTL_REDIS_S, payload).catch(() => {});
      console.log(`✅ Normales ${PERIODE.debut}-${PERIODE.fin} calculées (ERA5, ${mois[0].jours} jours pour janvier).`);
      return payload;
    } catch (e) {
      _echecLe = Date.now();
      console.error("❌ Normales indisponibles :", e.message);
      return null;
    } finally {
      _enCours = null;
    }
  })();

  return _enCours;
}

/**
 * Ce que consomme `/meteo/commune` : les normales SI elles sont déjà connues.
 *
 * Ne bloque jamais la réponse citoyenne sur trente ans de données. Si elles
 * manquent, le calcul part en arrière-plan et la fenêtre météo s'affiche sans
 * écart — exactement comme aujourd'hui — puis l'obtient au chargement suivant.
 */
async function normalesSiPretes() {
  const connues = await lireNormales();
  if (connues) return connues;
  calculerNormales().catch(() => {});
  return null;
}

/** Normale du mois demandé (1-12), ou `null`. */
function normaleDuMois(payload, mois) {
  if (!payload || !Array.isArray(payload.mois)) return null;
  return payload.mois.find((m) => m.mois === Number(mois)) || null;
}

module.exports = {
  PERIODE, CLE_REDIS, MOIS_FR,
  joursAttendus, agregerNormales, construirePayload,
  lireNormales, calculerNormales, normalesSiPretes, normaleDuMois,
};
