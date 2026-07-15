// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
/*
 * Tests de lib/vigieau.js — double requête coordonnées + commune (ADR-0009).
 *
 * fetchVigieauStatus interroge /zones deux fois (lon/lat + commune, puis commune
 * seule) et retient le niveau LE PLUS GRAVE des réponses exploitables : l'index
 * commune→zones de l'API officielle peut « oublier » une zone (constaté le
 * 15/07/2026 : zone AEP « alerte renforcée » absente de la réponse par commune).
 *
 * Aucun appel réseau réel : axios.get est remplacé par un mock qui route selon
 * la présence de `params.lat` (requête coordonnées) ou non (requête commune).
 * Le détail /zones/{id} (consignes) est reconnu par l'URL.
 *
 * Lancer : npm test (ou node test/vigieau.test.js)
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { fetchVigieauStatus, vigieauSignature } = require("../lib/vigieau");

// handlers = { coords(params), commune(params), detail(url) } — chacun renvoie la
// réponse axios ({ status, data }) ou jette (erreur réseau).
async function withAxiosMock(handlers, fn) {
  const orig = axios.get;
  axios.get = async (url, opts) => {
    const params = (opts && opts.params) || {};
    if (/\/zones\/[^/?]+$/.test(url)) {
      return handlers.detail ? handlers.detail(url) : { status: 200, data: { usages: [] } };
    }
    return params.lat != null ? handlers.coords(params) : handlers.commune(params);
  };
  try {
    return await fn();
  } finally {
    axios.get = orig;
  }
}

const ZONE_AEP_RENFORCEE = { id: "z-aep", nom: "Réseau AEP Val d'Ardoux", type: "AEP", niveauGravite: "alerte_renforcee", arrete: { id: "arr-42" } };
const ZONE_SUP_VIGILANCE = { id: "z-sup", nom: "Loire moyenne", type: "SUP", niveauGravite: "vigilance" };

test("coordonnées plus graves que commune → on retient le niveau des coordonnées", async () => {
  const status = await withAxiosMock({
    coords:  () => ({ status: 200, data: [ZONE_AEP_RENFORCEE, ZONE_SUP_VIGILANCE] }),
    commune: () => ({ status: 200, data: [ZONE_SUP_VIGILANCE] }),
  }, () => fetchVigieauStatus("45203"));

  assert.equal(status.level, 3);
  assert.equal(status.label, "alerte renforcée");
  assert.equal(status.arreteId, "arr-42");
  assert.equal(status.zones.length, 2);
  assert.equal(vigieauSignature(status), "3|arr-42");
});

test("commune plus grave que coordonnées (index inverse) → on retient la commune", async () => {
  const status = await withAxiosMock({
    coords:  () => ({ status: 200, data: [ZONE_SUP_VIGILANCE] }),
    commune: () => ({ status: 200, data: [{ id: "z2", type: "SOU", niveauGravite: "alerte" }] }),
  }, () => fetchVigieauStatus("45203"));

  assert.equal(status.level, 2);
  assert.equal(status.label, "alerte");
});

test("coordonnées vides mais commune en alerte → pas de faux « aucune restriction »", async () => {
  const status = await withAxiosMock({
    coords:  () => ({ status: 200, data: [] }),
    commune: () => ({ status: 200, data: [{ id: "z2", type: "SUP", niveauGravite: "alerte" }] }),
  }, () => fetchVigieauStatus("45203"));

  assert.equal(status.level, 2);
});

test("requête coordonnées en échec → repli sur la requête commune", async () => {
  const status = await withAxiosMock({
    coords:  () => { throw new Error("ECONNRESET"); },
    commune: () => ({ status: 200, data: [ZONE_SUP_VIGILANCE] }),
  }, () => fetchVigieauStatus("45203"));

  assert.equal(status.level, 1);
  assert.equal(status.label, "vigilance");
});

test("commune en 409 (multi-zone) mais coordonnées exploitables → niveau déterminé", async () => {
  const status = await withAxiosMock({
    coords:  () => ({ status: 200, data: [ZONE_AEP_RENFORCEE] }),
    commune: () => ({ status: 409, data: {} }),
  }, () => fetchVigieauStatus("45203"));

  assert.equal(status.level, 3);
});

test("les deux requêtes vides → level 0 explicite (levée des restrictions)", async () => {
  const status = await withAxiosMock({
    coords:  () => ({ status: 200, data: [] }),
    commune: () => ({ status: 200, data: [] }),
  }, () => fetchVigieauStatus("45203"));

  assert.equal(status.level, 0);
  assert.equal(status.label, null);
  assert.deepEqual(status.zones, []);
});

test("les deux requêtes en échec → level null, raison de la requête prioritaire", async () => {
  const status = await withAxiosMock({
    coords:  () => { throw new Error("boom"); },
    commune: () => ({ status: 503, data: {} }),
  }, () => fetchVigieauStatus("45203"));

  assert.equal(status.level, null);
  assert.equal(status.reason, "network");
});

test("consignes : récupérées via /zones/{id} de la zone la plus grave (niveau ≥ 2)", async () => {
  const status = await withAxiosMock({
    coords:  () => ({ status: 200, data: [ZONE_AEP_RENFORCEE] }),
    commune: () => ({ status: 200, data: [] }),
    detail:  (url) => {
      assert.ok(url.endsWith("/zones/z-aep"));
      return { status: 200, data: { usages: [
        { nom: "Arrosage des pelouses", niveauRestriction: "Interdiction" },
        { nom: "Remplissage des piscines", niveauRestriction: "Interdiction" },
      ] } };
    },
  }, () => fetchVigieauStatus("45203"));

  assert.equal(status.level, 3);
  assert.equal(status.consignes.length, 2);
  assert.equal(status.consignes[0].usage, "Arrosage des pelouses");
});
