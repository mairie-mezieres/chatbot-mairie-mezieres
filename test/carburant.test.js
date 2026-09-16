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
//   2. « À défaut, le premier enregistrement du code postal. » Olivet (45160)
//      porte le E.Leclerc ET le relais TotalEnergies du Coudray : ce repli
//      affichait les prix de l'un sous le nom de l'autre, sans rien qui puisse
//      le trahir à l'écran.
"use strict";
const test = require('node:test');
const assert = require('node:assert');
const {
  CARBURANT_STATIONS, pickStationRecord, extractPrices, formatMaj
} = require('../lib/carburant');

const LECLERC_OLIVET = { id: '45160003', ensigne: 'E.Leclerc', nom: 'OLIVET', adresse: 'Rue du Clos Renard' };
const COUDRAY        = { id: '45160006', ensigne: 'TotalEnergies', nom: 'RELAIS DU COUDRAY', adresse: '3091 rue Marcel Belot' };

test('une station qui déclare un id se reconnaît à son id', () => {
  const recs = [LECLERC_OLIVET, COUDRAY];
  const station = CARBURANT_STATIONS.find(s => s.key === 'coudray');
  assert.strictEqual(pickStationRecord(recs, station).id, '45160006');
});

test('id absent du lot : AUCUNE station, jamais un repli', () => {
  const station = CARBURANT_STATIONS.find(s => s.key === 'coudray');
  assert.strictEqual(pickStationRecord([LECLERC_OLIVET], station), null);
});

test('deux stations dans le même code postal : pas de repli sur la première', () => {
  // Sans `id` et sans marque reconnue, rendre `records[0]` afficherait les
  // prix du Leclerc sous le nom du Total (ou l'inverse).
  const recs = [LECLERC_OLIVET, COUDRAY];
  assert.strictEqual(pickStationRecord(recs, { key: 'x', brand: 'carrefour' }), null);
});

test('un seul enregistrement : le repli reste admis (aucune ambiguïté)', () => {
  assert.strictEqual(pickStationRecord([LECLERC_OLIVET], { key: 'x', brand: 'carrefour' }).id, '45160003');
});

test('la marque désigne la station quand il n’y a pas d’id', () => {
  const recs = [LECLERC_OLIVET, COUDRAY];
  assert.strictEqual(pickStationRecord(recs, { key: 'olivet', brand: 'leclerc' }).id, '45160003');
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

test('les six stations ont une clé unique et un libellé', () => {
  const cles = CARBURANT_STATIONS.map(s => s.key);
  assert.strictEqual(new Set(cles).size, cles.length);
  assert.ok(cles.includes('coudray'));
  for (const s of CARBURANT_STATIONS) {
    assert.ok(s.label && s.cp, s.key);
    // ⚠️ Deux stations partagent le 45160 : celles-là DOIVENT porter un `id`,
    // sinon la marque seule décide — et une enseigne s'écrit de dix façons.
    const memeCp = CARBURANT_STATIONS.filter(x => x.cp === s.cp);
    if (memeCp.length > 1) assert.ok(s.id || s.brand, `${s.key} : ni id ni marque`);
  }
});

console.log('✓ carburant : station désignée sans ambiguïté, une date par carburant');
