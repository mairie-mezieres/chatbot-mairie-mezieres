/*
 * Verrouille les données d'associations injectées dans le contexte de MEL
 * (grounding anti-hallucination). Si la liste dérive, ces tests le signalent.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ASSOCIATIONS, associationsContext } = require("../lib/mel");

test("liste exhaustive : 5 associations, pas de 'K-Rouge' inventé", () => {
  assert.equal(ASSOCIATIONS.length, 5);
  const noms = ASSOCIATIONS.map(a => a.nom.toLowerCase());
  assert.ok(!noms.some(n => n.includes("k-rouge")), "K-Rouge ne doit pas figurer");
  assert.ok(noms.some(n => n.includes("trialistes de l'ardoux")));
  assert.ok(noms.some(n => n.includes("germ")));
});

test("catégories sport = GERM (randonnée) + Trialistes (trial vélo)", () => {
  const sport = ASSOCIATIONS.filter(a => /sport/i.test(a.categorie)).map(a => a.nom);
  assert.equal(sport.length, 2);
  assert.ok(sport.some(n => n.includes("GERM")));
  assert.ok(sport.some(n => n.includes("Trialistes")));
});

test("associationsContext() rend un bloc exhaustif citant les 5 noms", () => {
  const ctx = associationsContext();
  assert.match(ctx, /liste exhaustive/i);
  for (const a of ASSOCIATIONS) assert.ok(ctx.includes(a.nom), `manque ${a.nom}`);
});
