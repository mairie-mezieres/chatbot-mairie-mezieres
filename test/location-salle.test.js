/*
 * Verrouille la DIRECT_RULE « salle communale / location de matériel » de MEL.
 *
 * Cas d'origine (23 août 2026) : « je souhaite louer la salle des fêtes, quel
 * est le tarif pour le 1er week-end d'octobre 2026 ? » — MEL partait dans la
 * catégorie « autre » et improvisait, alors que la salle N'EST PLUS LOUÉE.
 *
 * Le fait existait pourtant dans le dépôt, mais invisible :
 *   • enterré en 9e ligne d'un paragraphe de 200 mots dans la rubrique
 *     « Location de matériel » de `app-mezieres/data/mel-tree.json` ;
 *   • absent de l'autre copie de l'arbre (`app-mezieres/js/mat-mel.js`) ;
 *   • absent du backend, donc inconnu de MEL en texte libre.
 *
 * ⚠️ Aucun tarif n'est asserté ici : les prix vivent dans l'arbre de décision,
 * que la mairie édite depuis l'admin. La règle ne doit surtout pas les recopier.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findDirectAnswer, detectTopics, DIRECT_RULES } = require("../lib/mel");
const { normalizeQuestion } = require("../lib/text");

const ask = q => findDirectAnswer(normalizeQuestion(q), []);

test("la question qui a échoué en production trouve la règle", () => {
  const a = ask("je souhaite louer la salle des fetes quel est le tarif pour le 1er week end d'octobre 2026");
  assert.ok(a, "aucune règle directe");
  assert.match(a, /n'est plus proposée à la location/);
});

test("la réponse est un refus net, pas une invitation à vérifier les disponibilités", () => {
  const a = ask("louer la salle des fêtes");
  assert.match(a, /ni tarif ni calendrier de réservation/);
  assert.doesNotMatch(a, /disponibilit/i);
  assert.doesNotMatch(a, /vérifier les dates/i);
});

test("aucun tarif n'est recopié dans le code (la mairie les édite depuis l'admin)", () => {
  const a = ask("louer la salle des fêtes");
  // Ni les montants de l'arbre de décision, ni aucun autre prix en euros.
  assert.doesNotMatch(a, /\d+(?:[.,]\d+)?\s*(?:€|euros?)/i);
  assert.match(a, /02 38 45 61 76/, "la mairie doit rester la source des tarifs");
});

test("le matériel réellement disponible est cité", () => {
  const a = ask("est-ce que je peux louer des tables et des chaises");
  assert.ok(a);
  assert.match(a, /barnum/);
  assert.match(a, /caution/);
});

test("formulations variées d'habitants", () => {
  const questions = [
    "je voudrais réserver la salle communale pour un anniversaire",
    "combien coûte la location de la salle polyvalente",
    "peut-on louer la salle municipale le samedi",
    "quel est le prix de la salle des fetes",
    "location de barnum",
    "tarif location tables et chaises",
    "je veux louer du matériel communal",
  ];
  for (const q of questions) {
    assert.ok(ask(q), `pas de réponse directe pour « ${q} »`);
  }
});

test("la règle ne capture pas les questions d'autres sujets", () => {
  for (const q of ["quel est le tarif de la cantine",
                   "tarifs du cimetière",
                   "je cherche un logement à louer",
                   "quel est le prix d'une concession",
                   "comment réserver un rendez-vous pour ma carte d'identité"]) {
    const a = ask(q);
    if (a) assert.doesNotMatch(a, /salle communale/, `« ${q} » ne doit pas tomber sur la règle salle`);
  }
});

test("aucune règle antérieure ne masque la règle salle", () => {
  const idx = DIRECT_RULES.findIndex(r => r.name === "location_salle_materiel");
  assert.ok(idx >= 0, "la règle location_salle_materiel doit exister");
  const q = normalizeQuestion("je souhaite louer la salle des fêtes, quel est le tarif ?");
  for (let i = 0; i < idx; i++) {
    assert.ok(!DIRECT_RULES[i].test(q), `la règle « ${DIRECT_RULES[i].name} » capture la question salle avant elle`);
  }
});

test("la cantine garde la main sur ses propres questions", () => {
  const a = ask("quels sont les tarifs du restaurant scolaire ?");
  assert.ok(a);
  assert.doesNotMatch(a, /salle communale/);
});

test("le topic location est détecté pour les stats", () => {
  assert.ok(detectTopics("louer la salle des fêtes").includes("location"));
  assert.ok(detectTopics("réservation de barnum").includes("location"));
});

test("les liens de la réponse restent cliquables (https complet, non collés à une ponctuation)", () => {
  const a = ask("louer la salle des fêtes");
  for (const m of a.match(/https?:\/\/[^\s<>]+/g) || []) {
    assert.doesNotMatch(m, /[).,;]$/, `URL collée à une ponctuation : ${m}`);
  }
});
