/*
 * Tests des documents du PLUi-H-D (routes/docs.js).
 *
 * Aucun appel réseau sortant réel : sans REDIS_URL, redisGet renvoie null et le
 * miroir mémoire de lib/store.js sert de source, donc le cycle ajouter → lister
 * → supprimer est jouable hors-ligne. Sans Cloudinary configuré, le chemin
 * « envoi de fichier » répond 503 de façon déterministe.
 *
 * ADMIN_PASSWORD est posé AVANT le require de l'app (chaque fichier de test
 * tourne dans son propre processus, cf. scripts/run-tests.sh).
 */
process.env.ADMIN_PASSWORD = "test-plui-secret";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../app");

let server, base;
const admin = { "x-admin-token": "test-plui-secret", "Content-Type": "application/json" };
const json = { "Content-Type": "application/json" };

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
});

const post = (body, headers = admin) =>
  fetch(base + "/admin/docs/plui", { method: "POST", headers, body: JSON.stringify(body) });

// ── Lecture publique ──────────────────────────────────────────
test("GET /docs/plui → 200 et une liste (public, sans auth)", async () => {
  const r = await fetch(base + "/docs/plui");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.docs));
});

// ── Auth ──────────────────────────────────────────────────────
test("POST /admin/docs/plui sans token → 401", async () => {
  const r = await post({ titre: "X", date: "2026-08-07", url: "https://exemple.fr/a.pdf" }, json);
  assert.equal(r.status, 401);
});

test("DELETE /admin/docs/plui/:id sans token → 401", async () => {
  const r = await fetch(base + "/admin/docs/plui/123", { method: "DELETE" });
  assert.equal(r.status, 401);
});

// ── Validation ────────────────────────────────────────────────
test("POST sans titre → 400", async () => {
  const r = await post({ date: "2026-08-07", url: "https://exemple.fr/a.pdf" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /titre/i);
});

test("POST avec une date mal formée → 400", async () => {
  const r = await post({ titre: "Enquête publique", date: "07/08/2026", url: "https://exemple.fr/a.pdf" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /AAAA-MM-JJ/);
});

test("POST sans url ni fichier → 400", async () => {
  const r = await post({ titre: "Enquête publique", date: "2026-08-07" });
  assert.equal(r.status, 400);
});

test("POST avec une url non-https → 400", async () => {
  const r = await post({ titre: "Enquête publique", date: "2026-08-07", url: "http://exemple.fr/a.pdf" });
  assert.equal(r.status, 400);
});

test("POST avec un fileB64 qui n'est pas un PDF → 400", async () => {
  const r = await post({ titre: "Pas un PDF", date: "2026-08-07", fileB64: "data:image/png;base64,iVBORw0KGgo=" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /PDF/i);
});

test("POST d'un vrai PDF sans Cloudinary configuré → 503 explicite", async () => {
  const r = await post({ titre: "Doc", date: "2026-08-07", fileB64: "data:application/pdf;base64,JVBERi0xLjQK" });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /lien/i);
});

test("DELETE d'un id inexistant → 404", async () => {
  const r = await fetch(base + "/admin/docs/plui/999999999", { method: "DELETE", headers: admin });
  assert.equal(r.status, 404);
});

// ── Cycle complet par lien ────────────────────────────────────
test("ajouter par lien → apparaît dans la liste publique → supprimer", async () => {
  const rAdd = await post({
    titre: "Enquête publique — dossier complet",
    date: "2026-08-07",
    url: "https://exemple.fr/enquete-publique.pdf"
  });
  assert.equal(rAdd.status, 200);
  const added = (await rAdd.json()).docs.find(d => d.titre === "Enquête publique — dossier complet");
  assert.ok(added, "le document doit être présent dans la réponse");
  assert.equal(added.date, "2026-08-07");
  assert.equal(added.url, "https://exemple.fr/enquete-publique.pdf", "un lien externe est renvoyé tel quel");
  assert.equal(added.fichier, false, "un document ajouté par lien n'est pas hébergé par nous");
  assert.equal(added.publicId, undefined, "le publicId Cloudinary ne fuite pas côté public");

  const rList = await fetch(base + "/docs/plui");
  const list = (await rList.json()).docs;
  assert.ok(list.some(d => d.id === added.id), "le document doit être visible côté public");

  const rDel = await fetch(base + `/admin/docs/plui/${added.id}`, { method: "DELETE", headers: admin });
  assert.equal(rDel.status, 200);
  assert.ok(!(await rDel.json()).docs.some(d => d.id === added.id), "le document doit avoir disparu");
});
