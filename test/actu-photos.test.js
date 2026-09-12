// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
//
// Plusieurs photos par actualité (v4.109) — ce qui doit rester vrai
// ─────────────────────────────────────────────────────────────────
// Deux formes de stockage coexistent pour toujours : les actus publiées AVANT
// la v4.109 n'ont que `photo` / `photoPublicId`, les suivantes ont `photos[]`.
// Toute lecture des images d'une actu passe donc par `actuPhotoList`. Ce qui se
// joue n'est pas l'affichage — une image manquante se voit — mais la
// SUPPRESSION : un `publicId` oublié laisse une image sur Cloudinary alors que
// l'actu qui la référençait n'existe plus. Plus rien ne permet de la retrouver,
// et rien ne le signale.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

const { normalizePhotoInputs, actuPhotoList, MAX_ACTU_PHOTOS } = require("../lib/actu");

test("normalizePhotoInputs accepte la forme historique (une chaîne)", () => {
  assert.deepStrictEqual(normalizePhotoInputs("data:image/jpeg;base64,AAA"), ["data:image/jpeg;base64,AAA"]);
  // routes/eau.js appelle toujours publishActuToFacebook avec une seule URL :
  // si cette forme cessait d'être acceptée, l'alerte sécheresse perdrait son
  // visuel sans qu'aucun test de la sécheresse ne rougisse.
  assert.deepStrictEqual(normalizePhotoInputs("https://example.org/a.jpg"), ["https://example.org/a.jpg"]);
});

test("normalizePhotoInputs écarte le vide et les doublons, et plafonne", () => {
  assert.deepStrictEqual(normalizePhotoInputs(null), []);
  assert.deepStrictEqual(normalizePhotoInputs(""), []);
  assert.deepStrictEqual(normalizePhotoInputs([]), []);
  assert.deepStrictEqual(normalizePhotoInputs(["a", "a", "  ", null, 42, "b"]), ["a", "b"]);
  const trop = Array.from({ length: MAX_ACTU_PHOTOS + 4 }, (_, i) => "img-" + i);
  assert.strictEqual(normalizePhotoInputs(trop).length, MAX_ACTU_PHOTOS);
});

test("actuPhotoList lit les actus d'AVANT la v4.109 (photo seule)", () => {
  assert.deepStrictEqual(
    actuPhotoList({ photo: "https://example.org/a.jpg", photoPublicId: "mat/actus/a" }),
    [{ url: "https://example.org/a.jpg", publicId: "mat/actus/a" }]
  );
  // Une actu issue du webhook Facebook n'a pas toujours de publicId (image
  // servie directement depuis Facebook) : elle reste listée, simplement sans
  // rien à supprimer côté Cloudinary.
  assert.deepStrictEqual(
    actuPhotoList({ photo: "https://example.org/fb.jpg" }),
    [{ url: "https://example.org/fb.jpg", publicId: null }]
  );
});

test("actuPhotoList rend TOUTES les images d'une actu multi-photos", () => {
  const actu = {
    photo: "https://example.org/1.jpg",
    photoPublicId: "mat/actus/1",
    photos: [
      { url: "https://example.org/1.jpg", publicId: "mat/actus/1" },
      { url: "https://example.org/2.jpg", publicId: "mat/actus/2" },
      { url: "https://example.org/3.jpg", publicId: "mat/actus/3" }
    ]
  };
  const ids = actuPhotoList(actu).map(p => p.publicId);
  assert.deepStrictEqual(ids, ["mat/actus/1", "mat/actus/2", "mat/actus/3"]);
});

test("actuPhotoList ignore les entrées sans url et tolère l'absence d'actu", () => {
  assert.deepStrictEqual(actuPhotoList(null), []);
  assert.deepStrictEqual(actuPhotoList({}), []);
  assert.deepStrictEqual(
    actuPhotoList({ photos: [{ publicId: "orphelin" }, { url: "https://example.org/ok.jpg" }] }),
    [{ url: "https://example.org/ok.jpg", publicId: null }]
  );
});

test("la couverture est la PREMIÈRE image — push, vignette bureau et agenda en dépendent", () => {
  const photos = [
    { url: "https://example.org/couverture.jpg", publicId: "c" },
    { url: "https://example.org/autre.jpg", publicId: "d" }
  ];
  assert.strictEqual(actuPhotoList({ photos })[0].url, "https://example.org/couverture.jpg");
});

test("/admin/actus/schedule transporte des images : il doit être en corps large", () => {
  // Le contrôle porte sur app.js et non sur une route : une programmation avec
  // photo répondait 413 (limite 256 Ko), ce qui se lit comme une panne réseau.
  const fs = require("fs");
  const path = require("path");
  const appJs = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(appJs, /_isLargeBodyRoute[\s\S]*"\/admin\/actus\/schedule"/);
});
