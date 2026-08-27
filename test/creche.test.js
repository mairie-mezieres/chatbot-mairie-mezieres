/*
 * Verrouille la DIRECT_RULE « crèche familiale Les Marmousets » de MEL.
 *
 * Source unique : le règlement de fonctionnement « parents » 2026-2027 du SIVU
 * (modifications à compter du 1er septembre 2026), transmis par la mairie le
 * 27 août 2026. Sa lecture a révélé deux affirmations fausses qui vivaient
 * depuis longtemps dans l'arbre de décision de MEL — et qui s'étaient
 * propagées telles quelles dans le corpus « Le saviez-vous ? » :
 *
 *   • « 17 assistantes maternelles » — le règlement en compte SEIZE (§1.4) ;
 *   • « les enfants de moins de 6 ans » — c'est de 10 SEMAINES à l'entrée à
 *     l'école maternelle (§1.1). Les « moins de six ans » qui figurent bien
 *     dans le règlement ne concernent QUE les places garanties de l'article
 *     D.214-7 (parents engagés dans un parcours d'insertion). Un chiffre lu
 *     dans la bonne source, au mauvais paragraphe, reste un chiffre faux.
 *
 * Aucun tarif n'est énoncé : la participation suit le barème national CNAF et
 * dépend des revenus et du nombre d'enfants à charge (§8.1). Même règle que
 * pour la salle communale — cf. test/location-salle.test.js.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findDirectAnswer, DIRECT_RULES } = require("../lib/mel");
const { normalizeQuestion } = require("../lib/text");

const ask = q => findDirectAnswer(normalizeQuestion(q), []);

test("les formulations naturelles atteignent la règle crèche", () => {
  for (const q of ["la crèche de Mézières",
                   "crèche Les Marmousets",
                   "comment inscrire mon enfant à la crèche ?",
                   "assistantes maternelles",
                   "où faire garder mon enfant ?"]) {
    const a = ask(q);
    assert.ok(a, `aucune règle directe pour « ${q} »`);
    assert.match(a, /Marmousets/);
  }
});

test("les deux chiffres faux ne peuvent pas revenir", () => {
  const a = ask("crèche Les Marmousets");
  assert.match(a, /16 assistantes maternelles/);
  assert.doesNotMatch(a, /17 assistantes|dix-sept/i,
    "le règlement 2026-2027 §1.4 compte 16 assistantes maternelles");
  assert.match(a, /10 semaines/);
  assert.match(a, /entrée à l'école maternelle/);
  assert.doesNotMatch(a, /moins de 6 ans|moins de six ans|0 à 6 ans/i,
    "de 10 semaines à l'entrée en maternelle — les « moins de six ans » du " +
    "règlement ne visent que les places garanties de l'article D.214-7");
});

test("la crèche reste rattachée à Cléry-Saint-André, pas à Mézières", () => {
  const a = ask("crèche Les Marmousets");
  assert.match(a, /Cléry-Saint-André/);
  assert.doesNotMatch(a, /la commune dispose d'une crèche/,
    "erreur relevée par la mairie le 2 août 2026 — ne pas réintroduire");
  // Les trois communes du SIVU
  for (const c of ["Cléry-Saint-André", "Mareau-aux-Prés", "Mézières-lez-Cléry"]) {
    assert.match(a, new RegExp(c));
  }
});

test("aucun tarif en euros : la participation suit le barème CNAF", () => {
  const a = ask("combien coûte la crèche Les Marmousets ?");
  assert.ok(a);
  assert.doesNotMatch(a, /\d+\s?(€|euros?)/i,
    "la participation dépend des revenus de chaque famille (barème CNAF, §8.1)");
  assert.match(a, /barème national de la CNAF/);
});

test("les contacts du règlement sont présents", () => {
  const a = ask("téléphone de la crèche");
  assert.match(a, /02 38 45 76 56/);
  assert.match(a, /crechemarmousets@orange\.fr/);
});

test("la règle crèche passe AVANT centre_loisirs", () => {
  const noms = DIRECT_RULES.map(r => r.name);
  assert.ok(noms.includes("creche"));
  assert.ok(noms.indexOf("creche") < noms.indexOf("centre_loisirs"),
    "sans cela, `creche` est avalé par le motif de centre_loisirs");
});

test("le LAEP garde la priorité sur la crèche : ce n'est pas un mode de garde", () => {
  const noms = DIRECT_RULES.map(r => r.name);
  assert.ok(noms.indexOf("laep") < noms.indexOf("creche"),
    "une question LAEP ne doit pas recevoir la réponse crèche");
  assert.match(ask("c'est quoi le LAEP ?"), /LAEP/);
});
