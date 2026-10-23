/*
 * Verrouille la DIRECT_RULE « aide de l'État au raccordement fibre » de MEL.
 *
 * Dispositif ASP : aide aux travaux en domaine privé quand l'opérateur a remis
 * une attestation d'échec de raccordement. Deux choses à garantir :
 *   • la demande est déposée par l'HABITANT, pas par la mairie ;
 *   • aucun montant, plafond ni date limite n'est recopié : le dispositif est
 *     temporaire et ses paramètres ont déjà changé.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findDirectAnswer, DIRECT_RULES } = require("../lib/mel");
const { normalizeQuestion } = require("../lib/text");

const ask = q => findDirectAnswer(normalizeQuestion(q), []);
const rule = DIRECT_RULES.find(r => r.name === "fibre_aide_raccordement");

test("les formulations naturelles trouvent l'aide, pas la règle fibre générale", () => {
  for (const q of ["Existe-t-il une aide pour le raccordement à la fibre ?",
                   "aide fibre",
                   "subvention raccordement fibre optique",
                   "mon opérateur m'a donné une attestation d'échec de raccordement",
                   "la fibre est-elle financée par l'État ?",
                   "aide ASP fibre"]) {
    assert.equal(ask(q), rule.answer, `« ${q} » ne tombe pas sur l'aide`);
  }
});

test("les questions fibre ordinaires gardent la règle fibre", () => {
  const fibre = DIRECT_RULES.find(r => r.name === "fibre").answer;
  for (const q of ["suis-je éligible à la fibre ?", "fibre construction neuve", "Lysséo"]) {
    assert.equal(ask(q), fibre, `« ${q} »`);
  }
});

test("la règle est placée avant `fibre`", () => {
  const i = DIRECT_RULES.findIndex(r => r.name === "fibre_aide_raccordement");
  const j = DIRECT_RULES.findIndex(r => r.name === "fibre");
  assert.ok(i >= 0 && i < j);
});

test("l'habitant dépose, la mairie non", () => {
  assert.match(rule.answer, /C'est vous qui déposez/);
  assert.match(rule.answer, /attestation d'échec de raccordement/);
  assert.match(rule.answer, /La mairie n'instruit pas ce dossier et ne le dépose pas/);
  assert.match(rule.answer, /https:\/\/www\.asp\.gouv\.fr\//);
});

test("aucun montant, aucune année, aucune date recopiés", () => {
  assert.doesNotMatch(rule.answer, /€|euro/i);
  assert.doesNotMatch(rule.answer, /\b20\d\d\b/);
  assert.doesNotMatch(rule.answer, /(^|[^\p{L}])(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)([^\p{L}]|$)/iu);
});
