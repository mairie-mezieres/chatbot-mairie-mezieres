// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
//
// Vidéo ou son d'une actualité (v4.130) — voir lib/actu-media.js et
// app-mezieres/docs/adr/0057-…. Ce qui se joue :
//  1. l'engagement d'accessibilité est exigé PAR LE SERVEUR (RGAA 4.1 / 4.3) ;
//  2. le genre vient du format relu chez Cloudinary, pas du navigateur ;
//  3. un média refusé est supprimé, et les TROIS chemins de suppression d'une
//     actu (suppression, purge, annulation d'une programmation) libèrent le
//     fichier — sinon 100 Mo restent sur Cloudinary sans rien pour les retrouver.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveActuMedia, actuMediaPublicIds, mediaKindFromFormat, MAX_ACTU_MEDIA_BYTES } = require("../lib/actu-media");

const PID = "mat/actus-media/abc123";
const deps = (res) => ({
  fetchResource: async () => res,
  posterUrl: (pid) => "https://res.cloudinary.com/x/video/upload/so_0/" + pid + ".jpg"
});

test("pas de média → null (une actu sans vidéo reste une actu)", async () => {
  assert.strictEqual(await resolveActuMedia(null, "", deps({})), null);
  assert.strictEqual(await resolveActuMedia(undefined, "", deps({})), null);
});

test("vidéo acceptée : genre lu sur le format, image d'attente, engagement stocké", async () => {
  const m = await resolveActuMedia({ publicId: PID, accessibilite: true }, "texte",
    deps({ format: "mp4", bytes: 5e6, duration: 61.4, secure_url: "https://res.cloudinary.com/x/video/upload/v1/" + PID + ".mp4" }));
  assert.strictEqual(m.kind, "video");
  assert.strictEqual(m.accessibilite, "sous-titres-incrustes");
  assert.strictEqual(m.duration, 61);
  assert.ok(m.poster && m.poster.endsWith(".jpg"));
  assert.ok(m.url.startsWith("https://"));
});

test("son accepté seulement si le texte de l'actu en reprend le contenu", async () => {
  const res = { format: "mp3", bytes: 2e6, secure_url: "https://res.cloudinary.com/x/video/upload/v1/a.mp3" };
  const m = await resolveActuMedia({ publicId: PID, accessibilite: true }, "Transcription : bonjour…", deps(res));
  assert.strictEqual(m.kind, "audio");
  assert.strictEqual(m.poster, null);
  assert.strictEqual(m.accessibilite, "transcription-dans-le-texte");
  await assert.rejects(resolveActuMedia({ publicId: PID, accessibilite: true }, "   ", deps(res)),
    (e) => e.status === 400 && e.discard === true);
});

test("⛔ sans l'engagement d'accessibilité, le serveur refuse et fait supprimer le fichier", async () => {
  for (const acc of [undefined, false, "true", 1]) {
    await assert.rejects(
      resolveActuMedia({ publicId: PID, accessibilite: acc }, "texte", deps({ format: "mp4", bytes: 1, secure_url: "https://x" })),
      (e) => e.status === 400 && e.discard === true && /Accessibilit/.test(e.message)
    );
  }
});

test("⛔ le genre annoncé par le navigateur est ignoré ; un format inconnu est refusé", async () => {
  const m = await resolveActuMedia({ publicId: PID, accessibilite: true, kind: "video" }, "texte",
    deps({ format: "mp3", bytes: 1, secure_url: "https://x" }));
  assert.strictEqual(m.kind, "audio");
  await assert.rejects(resolveActuMedia({ publicId: PID, accessibilite: true }, "t", deps({ format: "avi", bytes: 1, secure_url: "https://x" })),
    (e) => e.discard === true);
  assert.strictEqual(mediaKindFromFormat("MP4"), "video");
  assert.strictEqual(mediaKindFromFormat("m4a"), "audio");
  assert.strictEqual(mediaKindFromFormat(""), null);
});

test("trop lourd → refusé et supprimé", async () => {
  await assert.rejects(
    resolveActuMedia({ publicId: PID, accessibilite: true }, "t", deps({ format: "mp4", bytes: MAX_ACTU_MEDIA_BYTES + 1, secure_url: "https://x" })),
    (e) => e.discard === true
  );
});

test("un identifiant hors du dossier des médias d'actu est refusé SANS suppression", async () => {
  for (const pid of ["mat/actus/photo1", "mat/plui/plui-1.pdf", "../mat/actus-media/x", "mat/actus-media/", "", 42]) {
    await assert.rejects(
      resolveActuMedia({ publicId: pid, accessibilite: true }, "t", deps({ format: "mp4", bytes: 1, secure_url: "https://x" })),
      (e) => e.status === 400 && !e.discard
    );
  }
});

test("Cloudinary : 404 → 400 explicite ; panne → 502, rien n'est supprimé", async () => {
  const fail = (err) => ({ fetchResource: async () => { throw err; } });
  await assert.rejects(resolveActuMedia({ publicId: PID, accessibilite: true }, "t", fail({ error: { http_code: 404, message: "not found" } })),
    (e) => e.status === 400 && !e.discard);
  await assert.rejects(resolveActuMedia({ publicId: PID, accessibilite: true }, "t", fail(new Error("ETIMEDOUT"))),
    (e) => e.status === 502 && !e.discard);
});

test("actuMediaPublicIds : actu avec / sans média, brouillon programmé", () => {
  assert.deepStrictEqual(actuMediaPublicIds({ media: { publicId: PID } }), [PID]);
  assert.deepStrictEqual(actuMediaPublicIds({ photo: "x" }), []);
  assert.deepStrictEqual(actuMediaPublicIds({ media: null }), []);
  assert.deepStrictEqual(actuMediaPublicIds(null), []);
  assert.deepStrictEqual(actuMediaPublicIds({ media: { publicId: "mat/actus/autre" } }), []);
});

test("⛔ les trois chemins de suppression libèrent le média", () => {
  const lire = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  // Suppression d'une actu
  assert.match(lire("routes/admin-simple.js"), /actuMediaPublicIds\(actu\)[\s\S]{0,200}deleteActuMediaFromCloudinary/);
  // Purge par date
  assert.match(lire("routes/admin-purge.js"), /actuMediaPublicIds\(actu\)[\s\S]{0,200}deleteActuMediaFromCloudinary/);
  // Annulation d'une publication programmée
  assert.match(lire("routes/admin-actus.js"), /actuMediaPublicIds\(target\)/);
});
