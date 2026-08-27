/*
 * Verrouille les numéros de cerfa d'urbanisme cités par MEL.
 *
 * Cas d'origine (27 août 2026) : la veille « liens morts » a signalé un 404 sur
 * https://www.service-public.gouv.fr/particuliers/vosdroits/R11646, la fiche du
 * cerfa 13703, référencée par le zonage PLU de l'application. La page n'avait
 * pas déménagé : elle avait été SUPPRIMÉE, parce que le formulaire lui-même
 * n'existe plus. Au 1er janvier 2025, les cerfa 13703 (DP maison individuelle),
 * 13702 (DP lotissement) et 13404 (DP constructions et travaux) ont été abrogés
 * et remplacés par le 16702 (constructions et travaux) et le 16703
 * (aménagements). Le permis de construire, lui, reste le 13406.
 *
 * Un lien mort se voit ; un numéro de formulaire mort, non. MEL disait encore
 * « DP = n°13703 » — un habitant qui suivait cette consigne déposait un dossier
 * refusé, sans que rien dans l'application ne l'avertisse.
 *
 * Corollaire verrouillé ici aussi : ne jamais citer de MILLÉSIME (« 16702*02 »).
 * Le numéro à 5 chiffres est stable ; le millésime change tous les six mois et
 * périme la réponse en silence.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { findDirectAnswer, detectTopics } = require("../lib/mel");
const { normalizeQuestion } = require("../lib/text");

const ask = q => findDirectAnswer(normalizeQuestion(q), []);
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "lib", "mel.js"), "utf8");

const ABROGES = ["13703", "13702", "13404"];

test("la question « comment déposer une déclaration préalable » trouve la règle", () => {
  for (const q of ["comment déposer une déclaration préalable",
                   "comment déposer un permis de construire",
                   "où trouver le cerfa pour ma clôture",
                   "quel formulaire pour un abri de jardin"]) {
    const a = ask(q);
    assert.ok(a, `aucune règle directe pour « ${q} »`);
  }
});

test("la réponse nomme les formulaires en vigueur", () => {
  const a = ask("comment déposer une déclaration préalable");
  assert.match(a, /16702/, "la DP constructions et travaux doit renvoyer au 16702");
  assert.match(a, /16703/, "la DP aménagements doit renvoyer au 16703");
  assert.match(a, /13406/, "le permis de construire reste le 13406");
});

test("aucun formulaire abrogé n'est proposé à un habitant", () => {
  const a = ask("comment déposer une déclaration préalable");
  for (const n of ABROGES) {
    assert.doesNotMatch(a, new RegExp(n), `le cerfa ${n} est abrogé depuis le 1er janvier 2025`);
  }
});

test("le SYSTEM_PROMPT interdit explicitement les formulaires abrogés", () => {
  // Les DIRECT_RULES ne couvrent pas toutes les formulations : quand la
  // question part vers le modèle, c'est le prompt qui doit tenir la barrière.
  assert.match(SOURCE, /ABROGÉS depuis le 1er janvier 2025/);
  for (const n of ABROGES) {
    assert.ok(SOURCE.includes(n), `le garde-fou doit nommer le cerfa ${n} pour l'interdire`);
  }
});

test("un numéro de cerfa abrogé n'apparaît jamais hors du garde-fou", () => {
  // Seule exception admise : la phrase qui les déclare abrogés.
  const lignes = SOURCE.split("\n");
  for (let i = 0; i < lignes.length; i++) {
    if (!ABROGES.some(n => lignes[i].includes(n))) continue;
    assert.match(lignes[i], /ABROGÉS/,
      `ligne ${i + 1} : cerfa abrogé cité hors du garde-fou\n${lignes[i].slice(0, 200)}`);
  }
});

test("aucun millésime de cerfa n'est figé dans le code", () => {
  const lignes = SOURCE.split("\n");
  for (let i = 0; i < lignes.length; i++) {
    assert.doesNotMatch(lignes[i], /\b1[0-9]{4}\*\d{2}\b/,
      `ligne ${i + 1} : millésime de cerfa figé — n'écrire que le numéro à 5 chiffres\n${lignes[i].slice(0, 200)}`);
  }
});

test("les liens de la réponse restent cliquables (https complet, non collés à une ponctuation)", () => {
  const a = ask("comment déposer une déclaration préalable");
  const liens = a.match(/https?:\/\/[^\s<>]+/g) || [];
  assert.ok(liens.length, "la réponse doit porter au moins un lien cliquable");
  for (const m of liens) {
    assert.doesNotMatch(m, /[).,;]$/, `URL collée à une ponctuation : ${m}`);
  }
});

test("le topic urbanisme est détecté pour les stats", () => {
  assert.ok(detectTopics("comment déposer une déclaration préalable").includes("urbanisme"));
});
