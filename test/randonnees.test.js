/*
 * Verrouille la DIRECT_RULE « randonnees » de MEL.
 *
 * Octobre 2026 : « chemins de randonnées les vergers » et « plan des randonnées
 * sur mezières-lez-clery » recevaient « je n'ai pas cette information » alors que
 * l'app a une page randonnées dédiée (carte interactive des circuits).
 * La règle renvoie vers cette page sans recopier aucun nom de circuit ni chiffre.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findDirectAnswer, DIRECT_RULES } = require("../lib/mel");
const { normalizeQuestion } = require("../lib/text");

const ask = q => findDirectAnswer(normalizeQuestion(q), []);
const URL = "https://mairie-mezieres.github.io/randonnees/rando.html";

test("les questions remontées par la mairie trouvent la règle randonnées", () => {
  for (const q of ["chemins de randonnées les vergers",
                   "plan des randonnées sur mezières-lez-clery",
                   "où faire une rando ?",
                   "sentiers de promenade à Mézières",
                   "circuit pédestre",
                   "une balade en forêt"]) {
    const a = ask(q);
    assert.ok(a, `aucune règle directe pour « ${q} »`);
    assert.ok(a.includes(URL), `« ${q} » ne renvoie pas vers la page randonnées`);
  }
});

test("le lien est cliquable : suivi d'une espace, pas d'une ponctuation", () => {
  const a = ask("plan des randonnées");
  assert.match(a, new RegExp(URL.replace(/[.\/]/g, "\\$&") + " "));
});

test("« chemin des écoliers » reste au périscolaire", () => {
  const a = ask("chemin des écoliers") || "";
  assert.ok(!a.includes(URL));
});

test("aucun chiffre ni distance recopié dans la réponse", () => {
  const r = DIRECT_RULES.find(x => x.name === "randonnees");
  assert.ok(r);
  assert.doesNotMatch(r.answer, /\d+\s*(km|kilom|circuits|h\b|min)/i);
});
