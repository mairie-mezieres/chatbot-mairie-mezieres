/*
 * Verrouille les fiches « démarches administratives » injectées dans le
 * contexte de MEL et leur déclenchement par mots-clés. Cas d'origine :
 * « inscription liste électorale ? » → MEL répondait « je n'ai pas cette
 * information » car aucun topic n'était détecté.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DEMARCHES, demarchesContext, detectTopics } = require("../lib/mel");

test("fiches démarches : élections, procuration, recensement, CNI, état civil, PACS", () => {
  const titres = DEMARCHES.map(d => d.titre.toLowerCase());
  assert.ok(titres.some(t => t.includes("listes électorales")));
  assert.ok(titres.some(t => t.includes("procuration")));
  assert.ok(titres.some(t => t.includes("recensement")));
  assert.ok(titres.some(t => t.includes("identité") || t.includes("passeport")));
  assert.ok(titres.some(t => t.includes("état civil")));
  assert.ok(titres.some(t => t.includes("pacs")));
});

test("fiche élections : règles clés présentes (6e vendredi, service-public.fr, justificatifs)", () => {
  const fiche = DEMARCHES.find(d => /électorales/i.test(d.titre));
  assert.ok(fiche, "fiche listes électorales présente");
  assert.match(fiche.texte, /6e vendredi/);
  assert.match(fiche.texte, /service-public\.gouv\.fr\/particuliers\/vosdroits\/R16396/);
  assert.match(fiche.texte, /justificatif de domicile/);
});

test("demarchesContext : bloc balisé + renvoi mairie", () => {
  const ctx = demarchesContext();
  assert.match(ctx, /=== DÉMARCHES ADMINISTRATIVES/);
  assert.match(ctx, /02 38 45 61 76/);
  assert.match(ctx, /Inscription sur les listes électorales/);
});

test("détection du topic demarches sur les questions électorales", () => {
  // La question d'origine qui échouait
  assert.ok(detectTopics("inscription liste électorale?").includes("demarches"));
  assert.ok(detectTopics("comment voter par procuration ?").includes("demarches"));
  assert.ok(detectTopics("recensement de mon fils qui a 16 ans").includes("demarches"));
  assert.ok(detectTopics("où faire ma carte identité ?").includes("demarches"));
  // Pas de faux positif grossier
  assert.ok(!detectTopics("quels sont les horaires du bus ?").includes("demarches"));
});
