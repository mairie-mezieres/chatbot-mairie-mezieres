// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
//
// Prix carburant — désignation de la station et datation PAR CARBURANT.
//
// Deux pannes silencieuses à verrouiller :
//   1. La date retenue était la première trouvée (`sp95_maj || e10_maj ||
//      gazole_maj`). Le 16 septembre 2026, le E.Leclerc « Beaugency » (en fait
//      Tavers, 45190) servait un SP95 relevé le 08/09 et un gazole relevé le
//      16/09 : l'app datait les DEUX du 08/09. Le prix du jour passait pour un
//      prix de la semaine passée — et la même ligne pouvait dater un SP95
//      périmé de l'horodatage du gazole du matin.
//   2. « À défaut, le premier enregistrement du code postal. » Deux stations
//      dans un même code postal, et ce repli affiche les prix de l'une sous le
//      nom de l'autre, sans rien qui puisse le trahir à l'écran.
//      ⛔ MAIS restreindre ce repli aux codes postaux à un seul enregistrement
//      a vidé TROIS cartes sur six en production : le flux instantané v2 ne
//      porte AUCUNE enseigne, donc la correspondance par marque ne matche
//      jamais et `liste[0]` désignait seul les cinq stations. Les tests ne
//      l'ont pas vu parce qu'ils fabriquaient des enregistrements avec un
//      champ `ensigne` que le vrai jeu de données n'a pas — un test qui
//      invente ses données ne mesure que l'idée qu'on s'en fait. Le repli
//      n'est donc refusé que là où DEUX DE NOS STATIONS partagent le code
//      postal.
"use strict";
const test = require('node:test');
const assert = require('node:assert');
const {
  CARBURANT_STATIONS, pickStationRecord, extractPrices, formatMaj
} = require('../lib/carburant');

// ⚠️ LA FORME RÉELLE d'un enregistrement du flux instantané v2 : un `id`, un
// `cp`, une `adresse`, une `ville`, des prix. AUCUNE enseigne, aucun nom
// commercial. Tout test qui en invente un ment sur ce que le code reçoit.
const OLIVET_A = { id: '45160005', cp: '45160', adresse: 'RN 20',               ville: 'OLIVET' };
const OLIVET_B = { id: '45160006', cp: '45160', adresse: '3091 RUE MARCEL BELOT', ville: 'OLIVET' };
const CLERY_A  = { id: '45370001', cp: '45370', adresse: 'ROUTE DE BLOIS',       ville: 'CLERY-SAINT-ANDRE' };
const CLERY_B  = { id: '45370002', cp: '45370', adresse: 'RUE DU GATINAIS',      ville: 'CLERY-SAINT-ANDRE' };

/* ⚠️ Le lot que renvoie l'API pour un code postal. `liste[0]` est ce que
   l'ancien code désignait : pour le 45160, c'est le RELAIS — c'est ainsi que
   l'app a servi ses prix sous le nom du Leclerc jusqu'à la v4.120. */
const LOTS = { '45160': [OLIVET_B, OLIVET_A], '45370': [CLERY_A, CLERY_B] };
const lotPour = station => LOTS[station.cp] || LOTS['45370'];

test('⛔ LA RÉGRESSION : chaque station suivie ressort d’un lot SANS enseigne', () => {
  // C'est le test qui manquait. Le 16 septembre 2026, Cléry, Meung et Olivet
  // affichaient « Prix non communiqué » en production pendant que la suite
  // était verte.
  for (const station of CARBURANT_STATIONS) {
    const rec = pickStationRecord(lotPour(station), station);
    assert.ok(rec, `${station.key} : aucune station désignée`);
  }
});

test('⛔ les deux stations du 45160 ne se confondent pas', () => {
  // Le Leclerc affichait les prix du relais du Coudray depuis l'origine :
  // `liste[0]`, pour ce code postal, c'est le relais. Chacune doit désormais
  // ressortir sur SON identifiant, à partir du MÊME lot.
  const leclerc = CARBURANT_STATIONS.find(s => s.key === 'olivet');
  const relais  = CARBURANT_STATIONS.find(s => s.key === 'coudray');
  assert.ok(relais, 'le relais du Coudray a disparu de la liste');
  assert.strictEqual(pickStationRecord(LOTS['45160'], leclerc).id, '45160005');
  assert.strictEqual(pickStationRecord(LOTS['45160'], relais).id,  '45160006');
  // ⛔ Et surtout : pas le même enregistrement pour les deux.
  assert.notStrictEqual(
    pickStationRecord(LOTS['45160'], leclerc).id,
    pickStationRecord(LOTS['45160'], relais).id
  );
});

test('une station qui déclare un id se reconnaît à son id', () => {
  assert.strictEqual(pickStationRecord([OLIVET_A, OLIVET_B], { key: 'x', id: '45160006' }).id, '45160006');
});

test('id absent du lot : AUCUNE station, jamais un repli', () => {
  assert.strictEqual(pickStationRecord([OLIVET_A], { key: 'x', id: '45160006' }), null);
});

test('deux de NOS stations sur un même code postal : pas de repli', () => {
  // Le seul cas où le repli est refusé — sinon on afficherait les prix de
  // l'une sous le nom de l'autre. Le 45160 EST dans ce cas : une station qui y
  // oublierait son `id` ne doit rien afficher, pas hériter du premier venu.
  assert.strictEqual(pickStationRecord(LOTS['45160'], { key: 'sans-id', cp: '45160' }), null);
});

test('code postal à une seule de nos stations : le repli désigne le premier', () => {
  const clery = CARBURANT_STATIONS.find(s => s.key === 'clery');
  assert.strictEqual(pickStationRecord([CLERY_A, CLERY_B], clery).id, '45370001');
});

test('la marque désigne la station quand elle est là (elle ne l’est jamais)', () => {
  // ⚠️ Conservé pour la forme : si le jeu de données se remet à porter une
  // enseigne un jour, elle doit primer sur le repli.
  const avecEnseigne = [{ id: '1', cp: '45160', ensigne: 'TotalEnergies' },
                        { id: '2', cp: '45160', ensigne: 'E.Leclerc' }];
  assert.strictEqual(pickStationRecord(avecEnseigne, { key: 'x', cp: '45160', brand: 'leclerc' }).id, '2');
});

test('chaque carburant porte SA date', () => {
  const p = extractPrices({
    sp95_prix: null,  e10_prix: 2.149, e10_maj: '2026-09-08T08:53:00',
    gazole_prix: 2.369, gazole_maj: '2026-09-16T07:12:00'
  });
  assert.strictEqual(p.sp95, 2.149);
  assert.strictEqual(p.gazole, 2.369);
  assert.ok(p.sp95MajISO.startsWith('2026-09-08'), p.sp95MajISO);
  assert.ok(p.gazoleMajISO.startsWith('2026-09-16'), p.gazoleMajISO);
});

test('la date de la station est la PLUS ANCIENNE des prix affichés', () => {
  // ⛔ Jamais la plus récente : le bandeau d'accueil montre les deux prix sous
  // une seule date, et une date trop optimiste ferait passer un prix de huit
  // jours pour un prix du matin (ADR-0033 côté app).
  const p = extractPrices({
    e10_prix: 2.149,    e10_maj: '2026-09-08T08:53:00',
    gazole_prix: 2.369, gazole_maj: '2026-09-16T07:12:00'
  });
  assert.ok(p.majISO.startsWith('2026-09-08'), p.majISO);
});

test('un seul carburant renseigné : sa date fait la date de la station', () => {
  const p = extractPrices({ gazole_prix: 2.250, gazole_maj: '2026-09-16T00:01:00' });
  assert.strictEqual(p.sp95, null);
  assert.strictEqual(p.sp95MajISO, null);
  assert.ok(p.majISO.startsWith('2026-09-16'), p.majISO);
});

test('le repli SP95 → E10 emporte la date du E10, pas celle du SP95', () => {
  const p = extractPrices({
    sp95_prix: null, sp95_maj: '2026-09-16T09:00:00',
    e10_prix: 2.149, e10_maj:  '2026-09-08T08:53:00'
  });
  assert.strictEqual(p.sp95, 2.149);
  assert.ok(p.sp95MajISO.startsWith('2026-09-08'), p.sp95MajISO);
});

test('aucune date connue : tout est null, rien n’est inventé', () => {
  const p = extractPrices({ sp95_prix: 2.239, gazole_prix: 2.436 });
  assert.strictEqual(p.maj, null);
  assert.strictEqual(p.majISO, null);
  assert.strictEqual(p.sp95MajISO, null);
});

test('une date illisible ne produit pas de date', () => {
  assert.deepStrictEqual(formatMaj('pas une date'), { maj: null, majISO: null });
  assert.deepStrictEqual(formatMaj(null), { maj: null, majISO: null });
});

test('chaque station a une clé unique, un libellé — et un id si son cp est partagé', () => {
  const cles = CARBURANT_STATIONS.map(s => s.key);
  assert.strictEqual(new Set(cles).size, cles.length);
  for (const s of CARBURANT_STATIONS) {
    assert.ok(s.label && s.cp, s.key);
    // ⛔ Deux de nos stations sur un même code postal ne sont désignables que
    // par leur `id` : sans lui, aucune des deux n'affichera de prix.
    const memeCp = CARBURANT_STATIONS.filter(x => x.cp === s.cp);
    if (memeCp.length > 1) assert.ok(s.id, `${s.key} : cp partagé et pas d'id`);
  }
});

console.log('✓ carburant : station désignée sans ambiguïté, une date par carburant');
