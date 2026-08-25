/*
 * Verrouille la DIRECT_RULE « LAEP » (Lieu d'Accueil Enfants-Parents) de MEL.
 *
 * Le LAEP est un service itinérant de la Communauté de Communes des Terres du
 * Val de Loire, ouvert à compter du 7 septembre 2026. Deux confusions sont
 * faciles et coûteuses :
 *   • le prendre pour un mode de garde — c'est explicitement le contraire :
 *     l'adulte accompagnant reste avec l'enfant pendant toute la durée ;
 *   • le croire présent à Mézières — les communes d'accueil sont Beauce la
 *     Romaine, Beaugency, Cléry-Saint-André et Meung-sur-Loire, pas Mézières.
 *     Même classe d'erreur que la crèche Les Marmousets, corrigée le 2 août
 *     2026 après avoir contaminé le corpus « Le saviez-vous ? ».
 *
 * Les CRÉNEAUX (jours, horaires, salles) sont publiés par la CCTVL et ne
 * figurent volontairement pas dans le code : ils changeront sans que personne
 * ici ne le sache. Ce test verrouille donc aussi leur ABSENCE — leçon des
 * horaires de bruit inventés (test/bruit.test.js).
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findDirectAnswer, detectTopics, DIRECT_RULES } = require("../lib/mel");
const { normalizeQuestion } = require("../lib/text");

const ask = q => findDirectAnswer(normalizeQuestion(q), []);

test("les formulations naturelles trouvent la règle LAEP", () => {
  for (const q of ["c'est quoi le LAEP ?",
                   "Le LAEP",
                   "lieu d'accueil enfants parents",
                   "lieu d’accueil enfants-parents",
                   "accueil enfants parents"]) {
    const a = ask(q);
    assert.ok(a, `aucune règle directe pour « ${q} »`);
    assert.match(a, /LAEP/);
  }
});

test("les faits de la page CCTVL sont tous présents", () => {
  const a = ask("c'est quoi le LAEP ?");
  assert.match(a, /itinérant/);
  assert.match(a, /7 septembre 2026/);
  assert.match(a, /gratuit/i);
  assert.match(a, /sans inscription/);
  assert.match(a, /confidentiel/i);
  assert.match(a, /moins de 6 ans/);
  assert.match(a, /futurs parents/);
  assert.match(a, /accueillants/);
  assert.match(a, /secret professionnel/);
});

test("le LAEP n'est jamais présenté comme un mode de garde", () => {
  const a = ask("c'est quoi le LAEP ?");
  assert.match(a, /n'est pas un mode de garde/);
  assert.match(a, /reste avec lui/);
  assert.doesNotMatch(a, /halte.?garderie/i);
});

test("Mézières n'est pas annoncée comme commune d'accueil", () => {
  const a = ask("le LAEP passe à Mézières ?");
  assert.ok(a);
  assert.match(a, /pas de créneau à Mézières-lez-Cléry/);
  // Les quatre communes d'accueil, et elles seules.
  for (const c of ["Beauce la Romaine", "Beaugency", "Cléry-Saint-André", "Meung-sur-Loire"]) {
    assert.match(a, new RegExp(c));
  }
});

test("aucun créneau inventé : ni horaire, ni jour de semaine", () => {
  const a = ask("horaires du LAEP");
  assert.ok(a);
  // Aucun horaire (« 9h », « 9h30 », « 9h-12h », « 14 h 30 »…)
  assert.doesNotMatch(a, /\d{1,2}\s?h\s?\d{0,2}/,
    "la réponse ne doit annoncer aucun horaire : ils sont publiés par la CCTVL");
  // Aucun jour de la semaine
  assert.doesNotMatch(a, /\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/i,
    "la réponse ne doit annoncer aucun jour d'accueil");
  // …mais elle dit que le planning n'est pas publié et donne à qui demander
  assert.match(a, /planning des créneaux n'est pas encore publié/);
  assert.match(a, /06 62 65 59 04/);
  assert.match(a, /laep@ccterresduvaldeloire\.fr/);
  assert.match(a, /ccterresduvaldeloire\.fr\/laep-lieu-accueil-enfants-parents\//);
});

test("le lien CCTVL est cliquable : https complet, suivi d'une espace", () => {
  const a = ask("où se passe le LAEP ?");
  const urls = a.match(/https?:\/\/[^\s<>]+/g) || [];
  assert.ok(urls.length, "au moins un lien https attendu");
  for (const u of urls) {
    assert.doesNotMatch(u, /[.,;:)»]$/, `ponctuation avalée dans le href : ${u}`);
  }
});

test("la règle LAEP passe AVANT centre_loisirs", () => {
  const noms = DIRECT_RULES.map(r => r.name);
  assert.ok(noms.includes("laep"), "la règle laep doit exister");
  assert.ok(noms.indexOf("laep") < noms.indexOf("centre_loisirs"),
    "laep doit être testée avant centre_loisirs (le LAEP n'est pas un accueil de loisirs)");
});

test("une question LAEP déclenche le topic scolaire", () => {
  assert.ok(detectTopics("c'est quoi le LAEP ?").includes("scolaire"));
  assert.ok(detectTopics("lieu d'accueil enfants parents").includes("scolaire"));
});

test("la règle centre_loisirs ne renvoie plus vers l'ancien site WordPress", () => {
  const a = ask("centre de loisirs");
  assert.ok(a);
  assert.doesNotMatch(a, /rubrique Services à l'enfance/,
    "mezieres-lez-clery.fr sert désormais l'application : cette rubrique n'existe plus");
  assert.match(a, /commune partenaire de la crèche familiale Les Marmousets/,
    "le garde-fou « la crèche n'est pas à Mézières » doit rester");
});
