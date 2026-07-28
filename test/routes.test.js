/*
 * Tests d'intégration des routes — démarrent l'app Express réelle (app.js) sur
 * un port éphémère et tapent dessus via fetch natif (Node 22). Aucune dépendance
 * de test externe : node:test + app.listen(0) + fetch.
 *
 * Ne couvre que des chemins SANS effet réseau sortant (validation HMAC, auth
 * admin, health) : pas de vrai appel Redis/Trello/Mistral/Facebook.
 *
 * Lancer : npm test
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

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

// ── Santé (routes/core.js) ────────────────────────────────────
test("GET / → 200 et JSON de santé", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.status, /en ligne/);
});

// ── Auth admin (lib/middleware.adminAuth) ─────────────────────
test("GET /admin/dashboard sans token → 401", async () => {
  const r = await fetch(base + "/admin/dashboard");
  assert.equal(r.status, 401);
});

// ── Préflight CORS ────────────────────────────────────────────
test("OPTIONS (préflight) → 200", async () => {
  const r = await fetch(base + "/status", { method: "OPTIONS" });
  assert.equal(r.status, 200);
});

// ── Webhook Facebook : validation HMAC (routes/webhook.js) ────
test("POST /webhook sans FACEBOOK_APP_SECRET → 503 (fail closed)", async () => {
  delete process.env.FACEBOOK_APP_SECRET;
  const r = await fetch(base + "/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 503);
});

test("POST /webhook secret défini mais signature absente → 403", async () => {
  process.env.FACEBOOK_APP_SECRET = "test-secret";
  const r = await fetch(base + "/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 403);
});

test("POST /webhook signature HMAC invalide → 403", async () => {
  process.env.FACEBOOK_APP_SECRET = "test-secret";
  const r = await fetch(base + "/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": "sha256=deadbeef",
    },
    body: "{}",
  });
  assert.equal(r.status, 403);
});

test("POST /webhook signature valide, feed sans #MAT → 200 EVENT_RECEIVED (ignoré)", async () => {
  process.env.FACEBOOK_APP_SECRET = "test-secret";
  const body = JSON.stringify({
    object: "page",
    entry: [{ changes: [{ field: "feed", value: { message: "Conseil municipal lundi, sans hashtag" } }] }],
  });
  const sig = "sha256=" + crypto.createHmac("sha256", "test-secret").update(body).digest("hex");
  const r = await fetch(base + "/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": sig },
    body,
  });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "EVENT_RECEIVED");
  delete process.env.FACEBOOK_APP_SECRET;
});

// ── Compteur public d'installations (routes/stats-public.js) ──
// Le badge de l'app doit toujours refléter `services.installation`, c'est-à-dire
// le total affiché par le mail quotidien et le tableau de bord — jamais une
// valeur figée dans un cache annexe. `writeStats` n'écrit que le cache mémoire
// (le flush Redis est périodique), donc le test reste hors-ligne.
test("GET /api/install-count → total vivant de services.installation", async () => {
  const store = require("../lib/store");
  await store.writeStats({ services: { installation: 585 } });

  const r = await fetch(base + "/api/install-count");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { count: 585 });

  // Une nouvelle installation doit être visible immédiatement, sans TTL à attendre.
  await store.writeStats({ services: { installation: 586 } });
  const r2 = await fetch(base + "/api/install-count");
  assert.deepEqual(await r2.json(), { count: 586 });
});

test("GET /api/install-count sans stats → { count: 0 }", async () => {
  const store = require("../lib/store");
  await store.writeStats({});
  const r = await fetch(base + "/api/install-count");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { count: 0 });
});

test("POST /admin/stats/installations sans token → 401", async () => {
  const r = await fetch(base + "/admin/stats/installations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ total: 361 }),
  });
  assert.equal(r.status, 401);
});

// ── Contrat de validation des entrées (chemins de rejet, sans réseau) ──
async function postJson(path, body) {
  return fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /idee sans texte → 400", async () => {
  const r = await postJson("/idee", {});
  assert.equal(r.status, 400);
});

test("POST /photos sans photoB64 → 400", async () => {
  const r = await postJson("/photos", {});
  assert.equal(r.status, 400);
});

test("POST /photos avec photoB64 non-image → 400", async () => {
  const r = await postJson("/photos", { photoB64: "pas-une-image" });
  assert.equal(r.status, 400);
});

test("POST /admin/meteo/test-push sans token → 401", async () => {
  const r = await postJson("/admin/meteo/test-push", {});
  assert.equal(r.status, 401);
});

test("PATCH /admin/signals/:id sans token → 401", async () => {
  const r = await fetch(base + "/admin/signals/abc", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "resolved" }),
  });
  assert.equal(r.status, 401);
});
