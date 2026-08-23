/*
 * Verrouille la DIRECT_RULE « horaires de bruit » de MEL.
 *
 * Cas d'origine (23 août 2026) : le changelog v4.15 annonçait une règle directe
 * pour les horaires de bruit et de bricolage, mais aucune n'existait dans le
 * code. Conséquence, deux réponses fausses en production :
 *   • « Quelles sont les horaires de bruit » → « je n'ai pas cette information »
 *   • « À quelle heure j'ai le droit de faire du bruit ? » → horaires INVENTÉS
 *     (« interdit de 22h à 7h », « dimanche toute la journée ») attribués à un
 *     arrêté municipal qui n'existe pas.
 *
 * Les seuls horaires opposables sont ceux de l'arrêté préfectoral du Loiret du
 * 1er mars 1999. Ce test verrouille les plages ET l'absence des plages fausses.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findDirectAnswer, detectTopics, DIRECT_RULES } = require("../lib/mel");
const { normalizeQuestion } = require("../lib/text");

const ask = q => findDirectAnswer(normalizeQuestion(q), []);

test("les deux questions qui ont échoué en production trouvent la règle", () => {
  for (const q of ["Quelles sont les horaires de bruit",
                   "À quelle heure j'ai le droit de faire du bruit ?"]) {
    const a = ask(q);
    assert.ok(a, `aucune règle directe pour « ${q} »`);
    assert.match(a, /arrêté préfectoral du Loiret du 1er mars 1999/);
  }
});

test("les trois plages de l'arrêté préfectoral sont énoncées", () => {
  const a = ask("horaires de bruit");
  assert.match(a, /lundi au vendredi de 8h30 à 12h et de 14h30 à 19h30/);
  assert.match(a, /samedi de 9h à 12h et de 15h à 19h/);
  assert.match(a, /dimanche et les jours fériés de 10h à 12h/);
});

test("aucune des plages hallucinées en production n'apparaît", () => {
  const a = ask("horaires de bruit");
  assert.doesNotMatch(a, /22h à 7h/);
  assert.doesNotMatch(a, /toute la journée/);
  // L'arrêté est préfectoral : ne pas prêter à la commune un arrêté municipal.
  assert.doesNotMatch(a, /arrêté municipal/);
});

test("formulations variées d'habitants", () => {
  const questions = [
    "puis-je tondre le dimanche ?",
    "à quelle heure peut-on tondre sa pelouse",
    "mon voisin fait du bruit la nuit, que faire",
    "tapage nocturne",
    "nuisances sonores",
    "quand ai-je le droit de bricoler",
    "horaires autorisés pour la tronçonneuse",
    "est-ce que je peux passer le taille-haie samedi",
    "jusqu'à quelle heure faire du bruit le soir",
  ];
  for (const q of questions) {
    assert.ok(ask(q), `pas de réponse directe pour « ${q} »`);
  }
});

test("la règle ne capture pas les questions d'autres sujets", () => {
  // « horaire » sans terme de bruit : la mairie, la déchetterie, le bus.
  for (const q of ["quels sont les horaires de la mairie",
                   "horaires de la déchetterie",
                   "horaires du bus pour Orléans",
                   "quand est la collecte des poubelles",
                   "quel est le jour de collecte du bac jaune"]) {
    const a = ask(q);
    if (a) assert.doesNotMatch(a, /1er mars 1999/, `« ${q} » ne doit pas tomber sur la règle bruit`);
  }
});

test("aucune règle antérieure ne masque la règle bruit", () => {
  const idx = DIRECT_RULES.findIndex(r => r.name === "bruit_travaux_horaires");
  assert.ok(idx >= 0, "la règle bruit_travaux_horaires doit exister");
  const q = normalizeQuestion("à quelle heure j'ai le droit de faire du bruit ?");
  for (let i = 0; i < idx; i++) {
    assert.ok(!DIRECT_RULES[i].test(q), `la règle « ${DIRECT_RULES[i].name} » capture la question bruit avant elle`);
  }
});

test("le topic bruit est détecté pour les stats", () => {
  assert.ok(detectTopics("horaires de bruit").includes("bruit"));
  assert.ok(detectTopics("je voudrais tondre ma pelouse").includes("bruit"));
});

test("les liens de la réponse restent cliquables (https complet, non collés à une ponctuation)", () => {
  const a = ask("horaires de bruit");
  for (const m of a.match(/https?:\/\/[^\s<>]+/g) || []) {
    assert.doesNotMatch(m, /[).,;]$/, `URL collée à une ponctuation : ${m}`);
  }
});
