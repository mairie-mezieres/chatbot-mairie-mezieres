/*
 * Tests golden-master pour lib/dates.js
 *
 * IMPORTANT : le fuseau est fixé à Europe/Paris AVANT tout require, car
 * formatAlertDateFr utilise toLocaleString sans timeZone explicite — son
 * rendu dépend donc du fuseau du process. On le verrouille pour des tests
 * déterministes, indépendamment de la machine (CI, Render, local).
 *
 * Lancer : npm test
 */
process.env.TZ = "Europe/Paris";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const dates = require("../lib/dates");
const golden = require("./golden/dates-golden.json");

// Garde-fou : si le fuseau n'a pas pris, les golden météo seraient faux.
test("fuseau de test bien fixé à Europe/Paris", () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "Europe/Paris");
});

test("formatAlertDateFr — golden master (DST été/hiver, entrées invalides)", () => {
  for (const [input, expected] of golden.formatAlertDateFr) {
    assert.equal(
      dates.formatAlertDateFr(input),
      expected,
      `formatAlertDateFr(${JSON.stringify(input)}) doit valoir ${JSON.stringify(expected)}`
    );
  }
});

test("_isFerieDate — golden master (jours fériés zone B)", () => {
  for (const [iso, expectedComputed, expectedTruth] of golden.isFerieDate) {
    // Le golden a figé à la fois la valeur calculée et la vérité attendue :
    // les deux doivent coïncider (sinon le code d'origine était déjà faux).
    assert.equal(expectedComputed, expectedTruth, `cohérence golden pour ${iso}`);
    assert.equal(
      dates._isFerieDate(new Date(iso + "T12:00:00")),
      expectedComputed,
      `_isFerieDate(${iso}) doit valoir ${expectedComputed}`
    );
  }
});

test("getParisDateParts — invariants de structure (déterministe)", () => {
  const { day, month } = dates.getParisDateParts();
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/, "day au format YYYY-MM-DD");
  assert.match(month, /^\d{4}-\d{2}$/, "month au format YYYY-MM");
  assert.equal(month, day.slice(0, 7), "month = préfixe de day");
});
