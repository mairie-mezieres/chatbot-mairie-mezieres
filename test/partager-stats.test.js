/*
 * Tests de la collecte des profils du kit « Partager » (routes/stats-public.js).
 * Même approche que routes.test.js : app réelle sur port éphémère + fetch natif,
 * aucun appel réseau sortant réel (l'écriture Redis est best-effort et REDIS_URL
 * n'est pas défini en test → no-op silencieux).
 *
 * Lancer : node test/partager-stats.test.js (ou npm test)
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../app");

let server, base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
});

function postPartager(body) {
  return fetch(base + "/stats/partager", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /stats/partager sans commune → 400", async () => {
  const r = await postPartager({ population: 900, budget: 20 });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.match(j.error, /commune/i);
});

test("POST /stats/partager commune vide (espaces) → 400", async () => {
  const r = await postPartager({ commune: "   " });
  assert.equal(r.status, 400);
});

test("POST /stats/partager profil complet → 200 success", async () => {
  const r = await postPartager({
    commune: "Mairie de Saint-Exemple",
    population: 1250,
    budget: 20,
    niveau: "intermediaire",
    sovereign: true,
    host: "ovh",
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.success, true);
});

test("POST /stats/partager valeurs invalides normalisées → 200 (pas de 500)", async () => {
  // population non numérique, niveau hors enum, budget négatif : la route
  // normalise sans rejeter — seule la commune est obligatoire.
  const r = await postPartager({
    commune: "X".repeat(500),
    population: "beaucoup",
    budget: -5,
    niveau: "expert",
    sovereign: "oui",
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.success, true);
});

test("GET /admin/partager-profils sans token → 401", async () => {
  const r = await fetch(base + "/admin/partager-profils");
  assert.equal(r.status, 401);
});

// ── Profils d'essai écartés (lib/partager.js) ────────────────
const { isTestCommune, filterRealProfils, normalizeCommune } = require("../lib/partager");

test("POST /stats/partager commune de test → 200 ignored (aucune écriture)", async () => {
  for (const commune of ["ville test", "Ville Test", "VILLE-TEST", "Cancale", "cancale"]) {
    const r = await postPartager({ commune, population: 900, budget: 20 });
    assert.equal(r.status, 200, commune);
    const j = await r.json();
    assert.equal(j.success, true, commune);
    assert.equal(j.ignored, true, commune);
  }
});

test("POST /stats/partager vraie commune → pas de drapeau ignored", async () => {
  const r = await postPartager({ commune: "Mézières-lez-Cléry", population: 1250 });
  const j = await r.json();
  assert.equal(j.success, true);
  assert.equal(j.ignored, undefined);
});

test("isTestCommune : formes normalisées, mots entiers seulement", async () => {
  assert.equal(isTestCommune("  ville   test  "), true);
  assert.equal(isTestCommune("commune de test"), true);
  assert.equal(isTestCommune("Démo"), true);
  // Sous-chaîne « test » dans un vrai nom : ne doit PAS être écartée.
  assert.equal(isTestCommune("Testelin"), false);
  assert.equal(isTestCommune("Mézières-lez-Cléry"), false);
  assert.equal(isTestCommune(""), false);
  assert.equal(isTestCommune(null), false);
  assert.equal(normalizeCommune("Château-Renard"), "chateau renard");
});

test("PARTAGER_IGNORE_COMMUNES ajoute des communes sans toucher au code", async () => {
  const prev = process.env.PARTAGER_IGNORE_COMMUNES;
  process.env.PARTAGER_IGNORE_COMMUNES = "Saint-Exemple, Beaugency";
  try {
    assert.equal(isTestCommune("saint exemple"), true);
    assert.equal(isTestCommune("Beaugency"), true);
    assert.equal(isTestCommune("Cléry-Saint-André"), false);
  } finally {
    if (prev === undefined) delete process.env.PARTAGER_IGNORE_COMMUNES;
    else process.env.PARTAGER_IGNORE_COMMUNES = prev;
  }
});

test("filterRealProfils écarte les essais déjà stockés", async () => {
  const bruts = [
    { commune: "Ville test", date: "2026-09-05T10:00:00.000Z" },
    { commune: "Cancale", date: "2026-09-05T10:01:00.000Z" },
    { commune: "Beaugency", date: "2026-09-05T10:02:00.000Z" },
    null,
  ];
  const reels = filterRealProfils(bruts);
  assert.deepEqual(reels.map(p => p.commune), ["Beaugency"]);
  assert.deepEqual(filterRealProfils(undefined), []);
});
