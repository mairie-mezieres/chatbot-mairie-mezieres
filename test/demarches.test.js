/*
 * Verrouille les DIRECT_RULES « démarches administratives » de MEL (réponses
 * complètes instantanées, sans appel IA) et le déclenchement du topic par
 * mots-clés. Cas d'origine : « inscription liste électorale ? » → MEL
 * répondait « je n'ai pas cette information » car aucune règle directe ni
 * aucun mot-clé électoral n'existait.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findDirectAnswer, detectTopics } = require("../lib/mel");
const { normalizeQuestion } = require("../lib/text");

const ask = q => findDirectAnswer(normalizeQuestion(q), []);

test("inscription listes électorales : réponse directe avec téléservice R16396 et délai", () => {
  const a = ask("inscription liste électorale?"); // la question d'origine
  assert.ok(a, "une règle directe doit répondre");
  assert.match(a, /R16396/);
  assert.match(a, /6e vendredi/);
  assert.match(a, /justificatif de domicile/);
  // Variantes de formulation
  assert.ok(ask("comment s'inscrire pour voter aux prochaines élections ?"));
  assert.ok(ask("où en est ma carte électorale"));
});

test("procuration : réponse directe maprocuration.gouv.fr", () => {
  const a = ask("comment voter par procuration ?");
  assert.ok(a);
  assert.match(a, /maprocuration\.gouv\.fr/);
});

test("recensement citoyen : réponse directe (16 ans, JDC, inscription auto)", () => {
  const a = ask("recensement de mon fils qui a 16 ans");
  assert.ok(a);
  assert.match(a, /16e anniversaire/);
  assert.match(a, /Journée Défense/);
});

test("PACS : réponse directe (mairie sur rendez-vous ou notaire)", () => {
  const a = ask("comment se pacser à Mézières ?");
  assert.ok(a);
  assert.match(a, /notaire/);
});

test("les règles directes existantes restent intactes (CNI, état civil)", () => {
  assert.match(ask("où faire ma carte identité ?") || "", /biométrique/);
  assert.match(ask("il me faut un extrait d'acte de naissance") || "", /état civil/);
});

test("poulailler / basse-cour : réponse directe (urbanisme + RSD, seuil 50 volailles)", () => {
  const a = ask("quelle est la législation pour un poulailler chez un particulier ?");
  assert.ok(a, "une règle directe doit répondre");
  assert.match(a, /Règlement Sanitaire Départemental|RSD/i);
  assert.match(a, /50 volailles/);
  assert.ok(ask("puis-je installer un clapier à lapins ?"));
  assert.ok(ask("j'aimerais mettre des ruches dans mon jardin"));
});

test("pas de réponse directe hors sujet (bus) — l'IA garde la main", () => {
  assert.equal(ask("quels sont les horaires du bus ?"), null);
});

test("détection du topic demarches sur les questions électorales (stats + pages sources)", () => {
  assert.ok(detectTopics("inscription liste électorale?").includes("demarches"));
  assert.ok(detectTopics("comment voter par procuration ?").includes("demarches"));
  assert.ok(!detectTopics("quels sont les horaires du bus ?").includes("demarches"));
});
