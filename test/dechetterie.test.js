"use strict";
// La déchetterie de Cléry-Saint-André est FERMÉE LE MARDI. MEL l'a longtemps
// annoncée ouverte « du lundi au samedi » : ce test verrouille les deux endroits
// qui portent ses jours d'ouverture (règle dechets_collecte + SYSTEM_PROMPT).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { DIRECT_RULES } = require("../lib/mel.js");

test("dechets_collecte : la déchetterie est fermée le mardi", () => {
  const r = DIRECT_RULES.find((x) => x.name === "dechets_collecte");
  assert.ok(r, "règle dechets_collecte absente");
  assert.match(r.answer, /ferm[ée]e le mardi/);
  assert.doesNotMatch(r.answer, /du lundi au samedi/);
});

test("SYSTEM_PROMPT : aucun « lun-sam » pour la déchetterie", () => {
  const src = fs.readFileSync(path.join(__dirname, "../lib/mel.js"), "utf8");
  const ligne = src.split("\n").find((l) => l.includes("- Déchetterie de Cléry-Saint-André"));
  assert.ok(ligne, "ligne déchetterie du SYSTEM_PROMPT absente");
  assert.match(ligne, /MARDI/);
  assert.doesNotMatch(ligne, /lun-sam/);
});
