// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
//
// Facebook → app : un post à plusieurs photos donne une actu à plusieurs photos
// ────────────────────────────────────────────────────────────────────────────
// Le sens sortant (admin → Facebook) est couvert par actu-photos.test.js. Le
// sens ENTRANT avait le défaut inverse et parfaitement muet : le webhook ne
// lisait que `change.value.photo` (une chaîne, absente d'un post multiple) et
// `full_picture` (la couverture, et elle seule). Une publication à six photos
// produisait une actu à UNE image — un résultat d'apparence normale, que rien
// ne distingue d'un post réellement mono-photo.
//
// Ces tests ne font AUCUN appel réseau : sans PAGE_ACCESS_TOKEN la Graph API
// rend un tableau vide sans requête, et sans Cloudinary les URL sont conservées
// telles quelles.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");

const { normalizeWebhookPhotos, resolvePostImages } = require("../routes/webhook");
const { MAX_ACTU_PHOTOS } = require("../lib/actu");

test("le corps du webhook annonce ses images sous DEUX formes", () => {
  // Post à une photo : `photo`, une chaîne.
  assert.deepStrictEqual(
    normalizeWebhookPhotos({ item: "photo", photo: "https://scontent.example/1.jpg" }),
    ["https://scontent.example/1.jpg"]
  );
  // Post à plusieurs photos : `photos`, un tableau — et pas de `photo`.
  assert.deepStrictEqual(
    normalizeWebhookPhotos({
      item: "status",
      photos: ["https://scontent.example/1.jpg", "https://scontent.example/2.jpg"]
    }),
    ["https://scontent.example/1.jpg", "https://scontent.example/2.jpg"]
  );
});

test("normalizeWebhookPhotos écarte le vide, les doublons, et plafonne", () => {
  assert.deepStrictEqual(normalizeWebhookPhotos(null), []);
  assert.deepStrictEqual(normalizeWebhookPhotos({}), []);
  assert.deepStrictEqual(normalizeWebhookPhotos({ photos: "pas-un-tableau" }), []);
  assert.deepStrictEqual(
    normalizeWebhookPhotos({ photos: ["a", "a", "  ", null, 42, "b"], photo: "b" }),
    ["a", "b"]
  );
  const trop = Array.from({ length: MAX_ACTU_PHOTOS + 3 }, (_, i) => "https://x/" + i + ".jpg");
  assert.strictEqual(normalizeWebhookPhotos({ photos: trop }).length, MAX_ACTU_PHOTOS);
});

test("sans Graph API, les images du corps du webhook sont TOUTES reprises", async () => {
  // C'est le cas dégradé (PAGE_ACCESS_TOKEN absent ou périmé) : il ne doit pas
  // ramener l'actu à une seule image, sinon la panne de token se traduit par une
  // perte de contenu silencieuse plutôt que par une erreur.
  const photos = await resolvePostImages(null, [
    "https://scontent.example/1.jpg",
    "https://scontent.example/2.jpg",
    "https://scontent.example/3.jpg"
  ]);
  assert.strictEqual(photos.length, 3);
  assert.deepStrictEqual(photos[0], { url: "https://scontent.example/1.jpg", publicId: null });
  // La couverture est la PREMIÈRE : c'est elle que lisent le push et la vignette
  // bureau, qui ne connaissent que le champ `photo`.
  assert.strictEqual(photos[0].url, "https://scontent.example/1.jpg");
});

test("resolvePostImages plafonne aussi, et tolère un post sans image", async () => {
  const trop = Array.from({ length: MAX_ACTU_PHOTOS + 2 }, (_, i) => "https://x/" + i + ".jpg");
  assert.strictEqual((await resolvePostImages(null, trop)).length, MAX_ACTU_PHOTOS);
  assert.deepStrictEqual(await resolvePostImages(null, []), []);
  assert.deepStrictEqual(await resolvePostImages(null, null), []);
});
