/*
 * URL de livraison des documents PLUi hébergés (lib/cloudinary.pluiDocUrl).
 *
 * Régression du 7 août 2026 : l'`secure_url` renvoyé par l'upload donnait un
 * **401** dans le navigateur. Cloudinary bloque par défaut la livraison des
 * « types de médias restreints » — PDF en tête — et le contournement documenté
 * est la signature de l'URL. Le document s'envoyait donc bien, mais personne ne
 * pouvait l'ouvrir.
 *
 * `cloudinary.url()` ne fait que construire une chaîne : aucun appel réseau,
 * le test reste déterministe hors-ligne. Les identifiants ci-dessous sont
 * factices et posés avant le require (config.js lit l'env au chargement).
 */
process.env.CLOUDINARY_NAME   = "commune-test";
process.env.CLOUDINARY_KEY    = "123456789012345";
process.env.CLOUDINARY_SECRET = "abcdefghijklmnopqrstuvwxyz12";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { pluiDocUrl } = require("../lib/cloudinary");

const PUBLIC_ID = "mat/plui/plui-1786103578711.pdf";

test("l'URL est signée — sans quoi Cloudinary répond 401 sur un PDF", () => {
  const url = pluiDocUrl(PUBLIC_ID);
  assert.match(url, /\/s--[A-Za-z0-9_-]+--\//, "le segment de signature s--…-- doit être présent");
});

test("l'URL est servie en https depuis res.cloudinary.com", () => {
  assert.match(pluiDocUrl(PUBLIC_ID), /^https:\/\/res\.cloudinary\.com\//);
});

test("la livraison passe par raw/upload, pas image/upload", () => {
  const url = pluiDocUrl(PUBLIC_ID);
  assert.ok(url.includes("/raw/upload/"), "un PDF en image/upload est bloqué par Cloudinary");
  assert.ok(!url.includes("/image/upload/"));
});

test("le chemin conserve l'extension .pdf — c'est elle qui fixe le Content-Type", () => {
  const path = pluiDocUrl(PUBLIC_ID).split("?")[0];
  assert.ok(path.endsWith(".pdf"), `attendu un chemin en .pdf, reçu ${path}`);
});

test("la signature dépend du document — deux fichiers n'ont pas la même", () => {
  const a = pluiDocUrl("mat/plui/plui-1.pdf");
  const b = pluiDocUrl("mat/plui/plui-2.pdf");
  const sig = u => (u.match(/\/s--([A-Za-z0-9_-]+)--\//) || [])[1];
  assert.notEqual(sig(a), sig(b));
});

test("sans publicId, pas d'URL (document ajouté par lien)", () => {
  assert.equal(pluiDocUrl(null), null);
  assert.equal(pluiDocUrl(""), null);
  assert.equal(pluiDocUrl(undefined), null);
});
