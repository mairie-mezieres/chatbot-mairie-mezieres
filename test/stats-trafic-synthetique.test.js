// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
//
// ⛔ LA CI N'EST PAS UN HABITANT.
//
// Six specs Playwright du dépôt `app-mezieres` ne coupaient pas `onrender.com`
// (la première depuis le 31 août 2026). Chaque exécution appelait donc
// `/stats/track` pour de vrai, et Playwright partant d'un profil VIERGE, le
// `deviceId` était neuf à chaque test : un visiteur unique de plus, par test,
// par exécution. Le 16 septembre, 19 exécutions ont produit ~550 « visiteurs
// uniques » et 234 ouvertures du service « Carburant ».
//
// ⚠️ LE DANGER DU REMÈDE. Un filtre trop large efface de VRAIS habitants — et
// personne ne s'en apercevrait, puisqu'il ne laisse aucune trace. La moitié de
// ce fichier vérifie donc que le filtre NE MORD PAS : domaine de la commune,
// GitHub Pages, vrai Pixel 7, origine illisible, aucun en-tête.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { isSyntheticTraffic } = require("../lib/stats");

const req = (headers) => ({ headers });

test("⛔ le trafic de la CI est reconnu", () => {
  // Ce que Playwright envoie réellement : l'app est servie en local.
  assert.strictEqual(isSyntheticTraffic(req({ origin: "http://127.0.0.1:4173" })), true);
  assert.strictEqual(isSyntheticTraffic(req({ referer: "http://localhost:4173/index.html" })), true);
  assert.strictEqual(isSyntheticTraffic(req({ origin: "http://[::1]:4173" })), true);
});

test("un test qui s'annonce est reconnu, même sans origine", () => {
  assert.strictEqual(isSyntheticTraffic(req({ "x-mat-test": "1" })), true);
});

test("un agent d'automatisation franc est reconnu", () => {
  assert.strictEqual(isSyntheticTraffic(req({ "user-agent": "Mozilla/5.0 HeadlessChrome/120" })), true);
  assert.strictEqual(isSyntheticTraffic(req({ "user-agent": "curl/8.4.0" })), true);
});

test("⛔ UN HABITANT N'EST JAMAIS FILTRÉ", () => {
  // Le cas qui coûterait le plus cher : un filtre trop zélé efface des
  // visiteurs réels sans rien afficher. Chacune de ces requêtes doit compter.
  const habitants = [
    { origin: "https://mezieres-lez-clery.fr" },
    { referer: "https://mezieres-lez-clery.fr/index.html" },
    { origin: "https://mairie-mezieres.github.io" },
    // ⚠️ Playwright pose un UA de VRAI navigateur (devices['Pixel 7']) :
    // « HeadlessChrome » n'y apparaît pas. Un vrai Pixel 7 non plus — d'où
    // l'origine comme critère principal, et l'UA en simple complément.
    { origin: "https://mezieres-lez-clery.fr",
      "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" },
    // Un navigateur qui n'envoie ni Origin ni Referer (lien direct, PWA
    // installée) : on ne suppose rien, on compte.
    {},
    // Une origine illisible ne prouve rien : un doute n'efface pas un habitant.
    { origin: "pas-une-url" },
    { origin: "" },
  ];
  for (const h of habitants) {
    assert.strictEqual(isSyntheticTraffic(req(h)), false, JSON.stringify(h));
  }
});

test("une requête sans en-têtes du tout ne fait pas tomber le filtre", () => {
  assert.strictEqual(isSyntheticTraffic({}), false);
  assert.strictEqual(isSyntheticTraffic(null), false);
});

console.log("✓ trafic synthétique : la CI est écartée, l'habitant est compté");
