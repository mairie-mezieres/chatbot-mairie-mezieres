/*
 * Tests du miroir mémoire des listes programmées (routes/admin-actus.js).
 *
 * Sans REDIS_URL configuré, redisGet renvoie null : si les routes de
 * programmation fonctionnent quand même (créer → lister → annuler), c'est que
 * le miroir mémoire est bien la source de lecture — et donc que les crons à
 * la minute ne retournent plus vers Redis à chaque tick (quota Upstash).
 *
 * ADMIN_PASSWORD est posé AVANT le require de l'app : node --test isole chaque
 * fichier de test dans son propre processus, donc pas d'effet de bord sur
 * routes.test.js (qui teste justement les 401 sans mot de passe).
 */
process.env.ADMIN_PASSWORD = "test-mirror-secret";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../app");

let server, base;
const admin = { "x-admin-token": "test-mirror-secret", "Content-Type": "application/json" };

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
});

test("publication programmée : créer → lister → annuler via le miroir mémoire (sans Redis)", async () => {
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  // Créer
  const rAdd = await fetch(base + "/admin/actus/schedule", {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ title: "Test miroir", description: "desc", scheduledAt, publishFacebook: false })
  });
  assert.equal(rAdd.status, 200);
  const { scheduled: draft } = await rAdd.json();
  assert.equal(draft.title, "Test miroir");

  // Lister : l'entrée doit être visible alors qu'aucun Redis n'est configuré
  const rList = await fetch(base + "/admin/actus/scheduled", { headers: admin });
  assert.equal(rList.status, 200);
  const { scheduled: list } = await rList.json();
  assert.ok(list.some(s => s.id === draft.id), "l'entrée programmée doit venir du miroir mémoire");

  // Annuler
  const rDel = await fetch(base + "/admin/actus/scheduled/" + draft.id, { method: "DELETE", headers: admin });
  assert.equal(rDel.status, 200);

  const rList2 = await fetch(base + "/admin/actus/scheduled", { headers: admin });
  const { scheduled: list2 } = await rList2.json();
  assert.ok(!list2.some(s => s.id === draft.id), "l'entrée annulée ne doit plus apparaître");
});

test("publication immédiate texte seul + Facebook : plus de 400, l'erreur FB est surfacée (502 sans token)", async () => {
  // La règle historique « photo obligatoire pour Facebook » renvoyait 400.
  // Désormais le post texte seul est tenté ; sans PAGE_ACCESS_TOKEN (env de
  // test), l'étape Facebook échoue → 502 avec le détail, et l'actu n'est PAS créée.
  const r = await fetch(base + "/admin/actus/add", {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ title: "Actu texte seul", description: "d", publishFacebook: true, sendPush: false, createCalendar: false })
  });
  assert.equal(r.status, 502);
  const d = await r.json();
  assert.match(d.error || "", /Facebook/);
});

test("publication immédiate sans Facebook : succès hors-ligne, actu créée", async () => {
  const r = await fetch(base + "/admin/actus/add", {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ title: "Actu app seulement", description: "d", publishFacebook: false, sendPush: false, createCalendar: false })
  });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.actu.title, "Actu app seulement");
  assert.equal(d.actu.fb, null); // pas de trace FB quand la case n'est pas cochée
});

test("push programmé : créer puis annuler via le miroir mémoire (sans Redis)", async () => {
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const rAdd = await fetch(base + "/admin/push/schedule", {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ title: "Push miroir", body: "corps", scheduledAt })
  });
  assert.equal(rAdd.status, 200);
  const { notif } = await rAdd.json();
  assert.equal(notif.title, "Push miroir");

  const rDel = await fetch(base + "/admin/push/schedule/" + notif.id, { method: "DELETE", headers: admin });
  assert.equal(rDel.status, 200);
});
