// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";

/**
 * Normales saisonnières — l'agrégation, et rien que l'agrégation.
 *
 * Aucun appel réseau : `agregerNormales` est une fonction pure, et c'est elle qui
 * porte la règle métier. Les cas verrouillés ici sont ceux qui feraient afficher
 * une valeur fausse à un habitant — pas des cas d'école :
 *   - un `null` compté comme un 0 (la faute corrigée en v4.78, ADR-0022) ;
 *   - un mois lacunaire servi quand même ;
 *   - une provenance qui se tairait sur le fait qu'ERA5 n'est pas une station.
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  PERIODE, joursAttendus, agregerNormales, construirePayload, normaleDuMois,
} = require("../lib/normales");

/** Série quotidienne synthétique : Tx = base du mois, Tn = base - 8. */
function serie({ debut = PERIODE.debut, fin = PERIODE.fin, trous = 0, bases = null } = {}) {
  const time = [], temperature_2m_max = [], temperature_2m_min = [];
  const basesMois = bases || [7, 8, 12, 15, 19, 23, 26, 25, 21, 16, 11, 8];
  let poses = 0;
  for (let annee = debut; annee <= fin; annee++) {
    for (let mois = 1; mois <= 12; mois++) {
      const nb = new Date(Date.UTC(annee, mois, 0)).getUTCDate();
      for (let jour = 1; jour <= nb; jour++) {
        time.push(`${annee}-${String(mois).padStart(2, "0")}-${String(jour).padStart(2, "0")}`);
        // Les `trous` premiers jours de janvier sont des `null` (donnée absente).
        const manquant = trous > 0 && mois === 1 && poses < trous;
        if (manquant) poses++;
        temperature_2m_max.push(manquant ? null : basesMois[mois - 1]);
        temperature_2m_min.push(manquant ? null : basesMois[mois - 1] - 8);
      }
    }
  }
  return { time, temperature_2m_max, temperature_2m_min };
}

test("douze mois, avec la moyenne attendue", () => {
  const mois = agregerNormales(serie());
  assert.strictEqual(mois.length, 12);
  assert.strictEqual(mois[6].mois, 7);
  assert.strictEqual(mois[6].tmax, 26);
  assert.strictEqual(mois[6].tmin, 18);
  assert.strictEqual(mois[0].jours, joursAttendus(1, PERIODE.debut, PERIODE.fin));
});

test("un jour sans mesure ne compte pas pour 0 °C", () => {
  // 200 jours de janvier absents sur ~930 : sous le plafond de tolérance (20 %),
  // donc le mois reste servi — mais sa moyenne ne doit PAS être tirée vers le bas.
  const mois = agregerNormales(serie({ trous: 180 }));
  assert.strictEqual(mois[0].tmax, 7, "la moyenne doit ignorer les null, pas les compter comme 0");
  assert.ok(mois[0].jours < joursAttendus(1, PERIODE.debut, PERIODE.fin));
});

test("un mois trop lacunaire fait échouer TOUT le calcul", () => {
  // Onze mois sur douze ne se servent pas : mieux vaut aucun écart qu'un écart
  // affiché pour certains mois seulement, sans que l'habitant sache lesquels.
  assert.throws(
    () => agregerNormales(serie({ trous: 500 })),
    /mois 1 trop lacunaire/
  );
});

test("séries absentes, vides ou de longueurs différentes : refus explicite", () => {
  assert.throws(() => agregerNormales(null), /absente ou malformée/);
  assert.throws(() => agregerNormales({ time: [], temperature_2m_max: [], temperature_2m_min: [] }), /vide/);
  assert.throws(
    () => agregerNormales({ time: ["1991-01-01"], temperature_2m_max: [3], temperature_2m_min: [] }),
    /longueurs différentes/
  );
});

test("une valeur aberrante est écartée, pas moyennée", () => {
  const s = serie();
  const i = s.time.indexOf("1995-07-15");
  assert.ok(i > 0);
  s.temperature_2m_max[i] = 999;          // sentinelle, pas une température
  s.temperature_2m_min[i] = -9999;
  const mois = agregerNormales(s);
  assert.strictEqual(mois[6].tmax, 26, "la sentinelle ne doit pas déplacer la moyenne");
});

test("hors période : les années en dehors de 1991-2020 sont ignorées", () => {
  const s = serie({ debut: PERIODE.debut - 2, fin: PERIODE.fin });
  const mois = agregerNormales(s);
  assert.strictEqual(mois[0].jours, joursAttendus(1, PERIODE.debut, PERIODE.fin),
    "les deux années antérieures ne doivent pas gonfler le décompte");
});

test("une maximale moyenne sous la minimale est refusée", () => {
  // Colonnes interverties : les valeurs sont plausibles une à une, l'ensemble non.
  const s = serie();
  const tmp = s.temperature_2m_max;
  s.temperature_2m_max = s.temperature_2m_min;
  s.temperature_2m_min = tmp;
  assert.throws(() => agregerNormales(s), /incohérent/);
});

test("le payload porte sa provenance, et ne se dit jamais station", () => {
  const p = construirePayload(agregerNormales(serie()), { lat: 47.822, lon: 1.808 });
  assert.strictEqual(p.periode.debut, 1991);
  assert.strictEqual(p.periode.fin, 2020);
  assert.strictEqual(p.jeu, "ERA5");
  assert.strictEqual(p.licence, "CC BY 4.0");
  assert.strictEqual(p.reanalyse, true, "ERA5 est une réanalyse : le payload doit le dire");
  assert.strictEqual(p.station, null, "aucune station ne doit être annoncée");
  assert.match(p.etiquette, /1991-2020/);
  assert.match(p.etiquette, /ERA5/);
});

test("normaleDuMois retrouve le bon mois, et rien pour un mois absent", () => {
  const p = construirePayload(agregerNormales(serie()), { lat: 47.8, lon: 1.8 });
  assert.strictEqual(normaleDuMois(p, 8).tmax, 25);
  assert.strictEqual(normaleDuMois(p, 13), null);
  assert.strictEqual(normaleDuMois(null, 1), null);
});
