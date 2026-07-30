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
const { fetchVigieauStatus, vigieauSignature, decideDroughtAction } = require("../lib/vigieau");

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

test("lecture partielle (une requête en échec) → complete: false", async () => {
  const status = await withAxiosMock({
    coords:  () => { throw new Error("ETIMEDOUT"); },
    commune: () => ({ status: 200, data: [{ id: "z2", type: "SUP", niveauGravite: "alerte" }] }),
  }, () => fetchVigieauStatus("45203"));

  assert.equal(status.level, 2);
  assert.equal(status.complete, false);
});

test("les deux requêtes abouties → complete: true", async () => {
  const status = await withAxiosMock({
    coords:  () => ({ status: 200, data: [ZONE_AEP_RENFORCEE] }),
    commune: () => ({ status: 200, data: [] }),
  }, () => fetchVigieauStatus("45203"));

  assert.equal(status.complete, true);
});

test("zone la plus grave stable : à gravité égale, celle qui porte un arrêté", async () => {
  const sansArrete = { id: "z-a", type: "SOU", niveauGravite: "crise" };
  const avecArrete = { id: "z-b", type: "AEP", niveauGravite: "crise", arrete: { id: "arr-7" } };
  const s1 = await withAxiosMock({
    coords:  () => ({ status: 200, data: [sansArrete, avecArrete] }),
    commune: () => ({ status: 200, data: [] }),
  }, () => fetchVigieauStatus("45203"));
  const s2 = await withAxiosMock({
    coords:  () => ({ status: 200, data: [avecArrete, sansArrete] }),
    commune: () => ({ status: 200, data: [] }),
  }, () => fetchVigieauStatus("45203"));

  // L'ordre renvoyé par l'API ne doit pas changer la signature (sinon : re-notif).
  assert.equal(s1.arreteId, "arr-7");
  assert.equal(vigieauSignature(s1), vigieauSignature(s2));
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

// ── decideDroughtAction : quand notifier (bug du 30/07/2026) ─────────────────
// Deux notifications « crise » à un jour d'intervalle alors que le niveau n'avait
// pas bougé : la dédup portait sur `niveau|arrêté` et une lecture partielle
// pouvait faire redescendre puis remonter le niveau.

const S = (level, complete = true, arreteId = "arr-1") => ({ level, complete, arreteId });
const LAST = (level) => ({ level, sig: `${level}|arr-1`, at: "2026-07-29T10:00:00.000Z" });

test("niveau inchangé → aucune notification, même si l'arrêté change", () => {
  const d = decideDroughtAction({ status: S(4, true, "arr-2"), last: LAST(4), pending: null });
  assert.equal(d.action, "none");
  assert.equal(d.reason, "unchanged");
  assert.equal(d.memorize, true);
});

test("montée au-dessus du seuil → notification immédiate", () => {
  const d = decideDroughtAction({ status: S(3), last: LAST(1), pending: null });
  assert.equal(d.action, "publish");
  assert.equal(d.reason, "escalation");
});

test("montée vue par une lecture partielle → notifiée quand même (jamais sous-estimer)", () => {
  const d = decideDroughtAction({ status: S(4, false), last: LAST(2), pending: null });
  assert.equal(d.action, "publish");
});

test("montée sous le seuil (0 → vigilance) → pas de notification", () => {
  const d = decideDroughtAction({ status: S(1), last: LAST(0), pending: null });
  assert.equal(d.action, "none");
  assert.equal(d.reason, "below-threshold");
});

test("baisse sur lecture PARTIELLE → ignorée et niveau non mémorisé", () => {
  const d = decideDroughtAction({ status: S(2, false), last: LAST(4), pending: null });
  assert.equal(d.action, "none");
  assert.equal(d.reason, "descent-incomplete");
  assert.equal(d.memorize, false, "mémoriser 2 ferait voir le retour à 4 comme une montée → re-notif");
});

test("le scénario du bug ne renotifie plus : 4 → lecture partielle 2 → 4", () => {
  const last = LAST(4);
  const d1 = decideDroughtAction({ status: S(2, false), last, pending: null });
  assert.equal(d1.action, "none");
  // Le niveau mémorisé reste 4 (d1.memorize === false) : le cycle suivant est « unchanged ».
  const d2 = decideDroughtAction({ status: S(4), last, pending: d1.pending });
  assert.equal(d2.action, "none");
  assert.equal(d2.reason, "unchanged");
});

test("baisse complète → confirmation exigée avant de publier", () => {
  const d1 = decideDroughtAction({ status: S(0), last: LAST(4), pending: null });
  assert.equal(d1.action, "none");
  assert.equal(d1.reason, "descent-pending");
  assert.equal(d1.pending.level, 0);
  assert.equal(d1.pending.count, 1);
  assert.equal(d1.memorize, false);

  const d2 = decideDroughtAction({ status: S(0), last: LAST(4), pending: d1.pending });
  assert.equal(d2.action, "publish");
  assert.equal(d2.reason, "lifted");
});

test("baisse confirmée restant au-dessus du seuil → actu du nouveau niveau", () => {
  const pending = { level: 2, count: 1, since: "2026-07-30T06:00:00.000Z" };
  const d = decideDroughtAction({ status: S(2), last: LAST(4), pending });
  assert.equal(d.action, "publish");
  assert.equal(d.reason, "de-escalation");
});

test("baisse non confirmée (niveau différent au 2e passage) → compteur remis à 1", () => {
  const pending = { level: 0, count: 1, since: "2026-07-30T06:00:00.000Z" };
  const d = decideDroughtAction({ status: S(1), last: LAST(4), pending });
  assert.equal(d.action, "none");
  assert.equal(d.pending.count, 1);
  assert.equal(d.pending.level, 1);
});

test("statut indéterminé → aucune action, rien n'est mémorisé", () => {
  const d = decideDroughtAction({ status: { level: null, reason: "network" }, last: LAST(4), pending: null });
  assert.equal(d.action, "none");
  assert.equal(d.reason, "unknown");
  assert.equal(d.memorize, false);
});

test("force → publication même sans changement", () => {
  const d = decideDroughtAction({ status: S(4), last: LAST(4), pending: null, force: true });
  assert.equal(d.action, "publish");
  assert.equal(d.reason, "force");
});

test("première mesure (aucun état mémorisé) au-dessus du seuil → notification", () => {
  assert.equal(decideDroughtAction({ status: S(3), last: null, pending: null }).action, "publish");
  assert.equal(decideDroughtAction({ status: S(1), last: null, pending: null }).action, "none");
});
