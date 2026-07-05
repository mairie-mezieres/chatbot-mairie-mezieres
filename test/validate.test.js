/*
 * Tests unitaires du helper de validation (lib/validate.js). Fonctions pures,
 * pas de réseau.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { capStr, finiteNum, safeId, inEnum, geoPoint, geoPointNear } = require("../lib/validate");

test("capStr — plafonne, gère null/undefined/non-chaîne", () => {
  assert.equal(capStr("abcdef", 3), "abc");
  assert.equal(capStr("ok", 10), "ok");
  assert.equal(capStr(null, 5), "");
  assert.equal(capStr(undefined, 5), "");
  assert.equal(capStr(42, 5), "42");
  assert.equal(capStr("garde tout"), "garde tout"); // sans max
});

test("finiteNum — nombre fini ou null (jamais NaN)", () => {
  assert.equal(finiteNum("12.5"), 12.5);
  assert.equal(finiteNum(0), 0);
  assert.equal(finiteNum("abc"), null);
  assert.equal(finiteNum(""), null);
  assert.equal(finiteNum(null), null);
  assert.equal(finiteNum(Infinity), null);
});

test("safeId — entier positif sûr, sinon fallback", () => {
  assert.equal(safeId(42), 42);
  assert.equal(safeId("100"), 100);
  assert.equal(safeId(0), null);
  assert.equal(safeId(-3), null);
  assert.equal(safeId("oops"), null);
  assert.equal(safeId("oops", 999), 999);
});

test("inEnum — appartenance (comparaison en chaîne) sinon null", () => {
  assert.equal(inEnum("resolved", ["pending", "resolved"]), "resolved");
  assert.equal(inEnum("hack", ["pending", "resolved"]), null);
  assert.equal(inEnum(undefined, ["a"]), null);
});

test("geoPoint — coordonnées valides bornées, sinon { null, null }", () => {
  assert.deepEqual(geoPoint("47.8", "1.8"), { lat: 47.8, lon: 1.8 });
  assert.deepEqual(geoPoint(91, 0), { lat: null, lon: null });   // lat hors plage
  assert.deepEqual(geoPoint(0, 200), { lat: null, lon: null });  // lon hors plage
  assert.deepEqual(geoPoint("x", 1), { lat: null, lon: null });  // non numérique
  assert.deepEqual(geoPoint(undefined, undefined), { lat: null, lon: null });
});

test("geoPointNear — n'accepte que les points proches de la référence", () => {
  const REF = [47.822, 1.808]; // centre de la commune (OPEN_METEO_LAT/LON)
  // Point dans la commune ou à proximité → accepté
  assert.deepEqual(geoPointNear("47.84425", "1.81926", ...REF), { lat: 47.84425, lon: 1.81926 });
  assert.deepEqual(geoPointNear(47.79, 1.79, ...REF), { lat: 47.79, lon: 1.79 });
  // « Null Island » (0,0) — GPS indisponible sur certains téléphones → écarté
  assert.deepEqual(geoPointNear(0, 0, ...REF), { lat: null, lon: null });
  assert.deepEqual(geoPointNear("0.00000", "0.00000", ...REF), { lat: null, lon: null });
  // Point valide mais à des centaines de km (Paris) → écarté
  assert.deepEqual(geoPointNear(48.85, 2.35, ...REF), { lat: null, lon: null });
  // Coordonnées inversées (1.8, 47.8) → écarté
  assert.deepEqual(geoPointNear(1.81926, 47.84425, ...REF), { lat: null, lon: null });
  // Entrées invalides → écarté (même comportement que geoPoint)
  assert.deepEqual(geoPointNear("x", 1.8, ...REF), { lat: null, lon: null });
  // Orléans (~20 km) reste accepté — le rayon doit couvrir les alentours
  assert.deepEqual(geoPointNear(47.9, 1.9, ...REF), { lat: 47.9, lon: 1.9 });
});
