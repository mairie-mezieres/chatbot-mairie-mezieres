/*
 * Verrouille les DIRECT_RULES « arrivée dans la commune » de MEL, ajoutées
 * pour le guide d'arrivée des nouveaux habitants (idée d'un habitant) : MEL
 * ne savait rien du changement d'adresse, des compteurs eau/énergie ni de
 * l'inscription scolaire, et ne comprenait pas « je viens d'emménager ».
 *
 * Ces règles sont insérées AVANT cantine / centre_loisirs et APRÈS les règles
 * d'état civil : l'ordre du tableau DIRECT_RULES est la priorité (première
 * règle dont test() renvoie vrai). Les tests d'ordre ci-dessous sont donc la
 * partie la plus importante du fichier — c'est ce qui casse si quelqu'un
 * déplace le bloc.
 *
 * Verrouille aussi la correction du jour de collecte du bac jaune : trois
 * implémentations (app.js, mat-widgets.js, mat-desktop.js) disent mardi des
 * semaines paires, la réponse de MEL disait « un lundi sur deux ».
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findDirectAnswer, detectTopics } = require("../lib/mel");
const { normalizeQuestion } = require("../lib/text");

const ask = q => findDirectAnswer(normalizeQuestion(q), []);

test("nouvel habitant : check-list complète des démarches d'arrivée", () => {
  const a = ask("je viens d'emménager, que dois-je faire ?");
  assert.ok(a, "une règle directe doit répondre");
  assert.match(a, /Bienvenue à Mézières-lez-Cléry/);
  assert.match(a, /02 38 45 61 76/);
  assert.match(a, /lundi 14h-17h30/);
  assert.match(a, /service-public\.gouv\.fr/);
  assert.match(a, /portail-usagers\.ccterresduvaldeloire\.fr/);
  assert.match(a, /listes électorales/);
  assert.match(a, /valdeloire-fibre\.fr/);
  // Variantes de formulation
  assert.ok(ask("je suis un nouvel habitant de la commune"));
  assert.ok(ask("existe-t-il un guide d'arrivée ?"));
  assert.ok(ask("j'emménage bientôt"));
  assert.ok(ask("nous emménageons à Mézières le mois prochain"));
});

test("changement d'adresse : téléservice unique, La Poste, carte grise", () => {
  const a = ask("comment déclarer mon changement d'adresse ?");
  assert.ok(a);
  assert.match(a, /Je change de coordonnées/);
  assert.match(a, /La Poste/);
  assert.match(a, /ants\.gouv\.fr/);
  assert.ok(ask("je dois changer d'adresse sur mes papiers"));
  assert.ok(ask("réexpédition de mon courrier"));
});

test("compteurs eau / électricité / gaz : mise en service et relevé", () => {
  const a = ask("comment ouvrir mon compteur d'électricité ?");
  assert.ok(a);
  assert.match(a, /mise en service/);
  assert.match(a, /index/);
  assert.match(a, /02 38 44 59 35/); // CCTVL — eau potable et assainissement
  assert.ok(ask("souscrire un abonnement gaz"));
});

test("inscription scolaire : mairie d'abord, puis école de la Forêt", () => {
  const a = ask("comment inscrire mon enfant à l'école ?");
  assert.ok(a);
  assert.match(a, /certificat d'inscription/);
  assert.match(a, /école de la Forêt/);
  assert.match(a, /livret de famille/);
  assert.match(a, /certificat de radiation/);
  assert.ok(ask("inscription scolaire pour la rentrée"));
});

// ─── Tests d'ordre : le placement du bloc dans DIRECT_RULES ───────────

test("ordre : une question de cantine ne part pas sur l'inscription scolaire", () => {
  const a = ask("quels sont les menus de la cantine ?");
  assert.ok(a);
  assert.match(a, /restaurant scolaire/);
  assert.doesNotMatch(a, /certificat de radiation/);
});

test("ordre : le périscolaire et la crèche gardent leur règle", () => {
  const a = ask("y a-t-il une garderie périscolaire ?");
  assert.ok(a);
  assert.match(a, /Marmousets|périscolaire/);
});

test("ordre : une question précise l'emporte sur la check-list générique", () => {
  // Les règles d'état civil sont AVANT le bloc arrivée.
  assert.match(ask("je viens d'emménager, où faire ma carte d'identité ?") || "", /biométrique/);
  // Les règles précises du bloc arrivée sont AVANT nouvel_habitant.
  assert.match(ask("j'emménage, comment inscrire mon enfant à l'école ?") || "", /certificat d'inscription/);
});

test("pas de réponse directe hors sujet (bus) — l'IA garde la main", () => {
  assert.equal(ask("quels sont les horaires du bus ?"), null);
});

// ─── Séparateur des regex : l'apostrophe devient une espace ───────────
// normalizeQuestion remplace toute ponctuation par une espace, donc
// « carte d'identité » → « carte d identite » : trois caractères entre les
// deux mots. Les motifs écrits `carte.identit` (un seul caractère joker)
// ne matchaient donc PAS la formulation la plus naturelle, et ces trois
// démarches — toutes présentes dans le guide d'arrivée — tombaient dans
// l'IA au lieu de leur réponse directe.

test("l'apostrophe ne casse plus la carte d'identité ni la pièce d'identité", () => {
  assert.match(ask("où faire ma carte d'identité ?") || "", /biométrique/);
  assert.match(ask("il me faut une pièce d'identité") || "", /biométrique/);
  // La formulation sans apostrophe continue de fonctionner.
  assert.match(ask("où faire ma carte identité ?") || "", /biométrique/);
});

test("« maison de santé » et « centre de loisirs » écrits en toutes lettres", () => {
  assert.match(ask("où est la maison de santé ?") || "", /Val d'Ardoux/);
  assert.match(ask("y a-t-il un centre de loisirs ?") || "", /centre de loisirs/);
});

// ─── Non-régression : jour de collecte du bac jaune ───────────────────

test("collecte : le bac jaune est annoncé le mardi des semaines paires", () => {
  const a = ask("quand sort-on le bac jaune ?");
  assert.ok(a);
  assert.match(a, /mardi sur deux/);
  assert.match(a, /semaines paires/);
  assert.doesNotMatch(a, /lundi sur deux/);
  // Le bac gris reste le lundi.
  assert.match(a, /chaque lundi matin/);
});

// ─── Topic (stats onglet 🤖 IA + pages sources de buildContext) ───────

test("détection du topic demarches sur les questions d'emménagement", () => {
  assert.ok(detectTopics("je viens d'emménager").includes("demarches"));
  assert.ok(detectTopics("je suis un nouvel habitant").includes("demarches"));
  assert.ok(detectTopics("changement d'adresse").includes("demarches"));
  assert.ok(!detectTopics("quels sont les horaires du bus ?").includes("demarches"));
});
