// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
//
// Post Facebook multi-photos depuis l'admin — les photos doivent VRAIMENT partir
// ─────────────────────────────────────────────────────────────────────────────
// Jusqu'au correctif, le POST /feed final envoyait un objet JSON à clés
// « attached_media[0] ». En JSON, Graph API lit ce nom comme un champ littéral
// inconnu et l'ignore SANS ERREUR : le post partait en texte seul, avec un 200,
// et l'admin annonçait « avec 2 photos ». La notation à crochets n'a de sens
// qu'en formulaire (x-www-form-urlencoded), la forme documentée par Facebook.
"use strict";
process.env.PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "test-token";
process.env.FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID || "123";

const { test } = require("node:test");
const assert = require("node:assert");
const axios = require("axios");

const { publishActuToFacebook, buildMultiPhotoFeedBody } = require("../lib/actu");

test("buildMultiPhotoFeedBody produit un formulaire, pas un objet JSON", () => {
  const body = buildMultiPhotoFeedBody("Bonjour", ["11", "22"], "tok");
  assert.ok(body instanceof URLSearchParams);
  assert.strictEqual(body.get("message"), "Bonjour");
  assert.deepStrictEqual(JSON.parse(body.get("attached_media[0]")), { media_fbid: "11" });
  assert.deepStrictEqual(JSON.parse(body.get("attached_media[1]")), { media_fbid: "22" });
  assert.strictEqual(body.get("access_token"), "tok");
});

test("publishActuToFacebook (2 photos) : photos non publiées puis /feed en formulaire", async () => {
  const calls = [];
  const orig = axios.post;
  let n = 0;
  axios.post = async (url, data, opts) => {
    calls.push({ url, data, opts });
    if (url.endsWith("/photos")) return { data: { id: "ph" + (++n) } };
    return { data: { id: "123_post" } };
  };
  try {
    const r = await publishActuToFacebook("Titre", "Texte", null, null, null,
      ["https://res.cloudinary.com/x/a.jpg", "https://res.cloudinary.com/x/b.jpg"]);
    assert.strictEqual(r.mode, "photos");
    assert.strictEqual(r.photo_count, 2);

    const photos = calls.filter(c => c.url.endsWith("/photos"));
    assert.strictEqual(photos.length, 2);
    for (const p of photos) assert.strictEqual(p.data.published, false);

    const feed = calls.find(c => c.url.endsWith("/feed"));
    assert.ok(feed, "un POST /feed doit partir");
    // ⛔ Le cœur du bug : un objet simple serait sérialisé en JSON par axios.
    assert.ok(feed.data instanceof URLSearchParams, "le corps /feed doit être un formulaire");
    assert.strictEqual(feed.opts.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.deepStrictEqual(JSON.parse(feed.data.get("attached_media[0]")), { media_fbid: "ph1" });
    assert.deepStrictEqual(JSON.parse(feed.data.get("attached_media[1]")), { media_fbid: "ph2" });
  } finally {
    axios.post = orig;
  }
});
