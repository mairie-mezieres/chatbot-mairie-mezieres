/*
 * Tests de la résilience du cache horaires bus (lib/mel.remiNeedsRefresh).
 * On manipule l'état exporté remiCache (même référence que le module) et on
 * vérifie la décision de rafraîchissement (fraîcheur + backoff après échec).
 */
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { remiCache, remiNeedsRefresh } = require("../lib/mel");

function setRemi({ lastUpdate = null, lastErrorAt = null }) {
  remiCache.lastUpdate = lastUpdate;
  remiCache.lastErrorAt = lastErrorAt;
}

afterEach(() => setRemi({})); // remet un état neutre entre les cas

test("contenu frais (lastUpdate récent) → pas de refresh", () => {
  setRemi({ lastUpdate: new Date() });
  assert.equal(remiNeedsRefresh(), false);
});

test("jamais chargé et aucun échec récent → refresh", () => {
  setRemi({});
  assert.equal(remiNeedsRefresh(), true);
});

test("échec récent (dans la fenêtre de backoff) → pas de refresh (anti-martèlement)", () => {
  setRemi({ lastErrorAt: new Date() });
  assert.equal(remiNeedsRefresh(), false);
});

test("échec ancien (au-delà du backoff) → refresh", () => {
  setRemi({ lastErrorAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
  assert.equal(remiNeedsRefresh(), true);
});

test("cache périmé (lastUpdate > 7 j) → refresh", () => {
  setRemi({ lastUpdate: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) });
  assert.equal(remiNeedsRefresh(), true);
});
