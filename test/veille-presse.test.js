/*
 * Veille presse « Ils parlent de MAT » : réception, file d'attente, section du mail.
 *
 * Ce qui est verrouillé :
 *  - la route refuse sans clé, et la clé passe en EN-TÊTE ;
 *  - un même article (utm_*, www., barre finale, fragment) n'entre qu'une fois ;
 *  - un Redis injoignable ne fait PAS croire que la file est vide (503, rien écrit) ;
 *  - le mail affiche la section, puis vide la file — et seulement après l'envoi.
 *
 * Aucun appel réseau : Redis est remplacé par une Map pour la seule clé de la
 * veille, Resend est intercepté.
 *
 * Lancer : node test/veille-presse.test.js (ou npm test)
 */
process.env.RESEND_API_KEY    = process.env.RESEND_API_KEY    || "test-key";
process.env.DAILY_STATS_EMAIL = process.env.DAILY_STATS_EMAIL || "test@example.invalid";
process.env.CRON_SECRET       = process.env.CRON_SECRET       || "test-cron-secret";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Redis en mémoire pour la clé de la veille, AVANT que lib/veille-presse ne se charge.
const redis = require("../lib/redis");
const memoire = new Map();
let redisEnPanne = false;
const orig = { get: redis.redisGetResult, set: redis.redisSet, del: redis.redisDel };
redis.redisGetResult = async (k, o) => k !== "mat:veille:presse" ? orig.get(k, o)
  : (redisEnPanne ? { ok: false, value: null } : { ok: true, value: memoire.has(k) ? JSON.parse(memoire.get(k)) : null });
redis.redisSet = async (k, v) => k !== "mat:veille:presse" ? orig.set(k, v)
  : (redisEnPanne ? false : (memoire.set(k, JSON.stringify(v)), true));
redis.redisDel = async (k) => k !== "mat:veille:presse" ? orig.del(k) : memoire.delete(k);

const axios = require("axios");
const vp = require("../lib/veille-presse");
const app = require("../app");

let server, base, envoi, resendEchoue = false;
const KEY = process.env.CRON_SECRET;

before(async () => {
  axios.post = async (url, payload) => {
    if (String(url).includes("resend")) {
      if (resendEchoue) { const e = new Error("boom"); e.response = { status: 500, data: { message: "boom" } }; throw e; }
      envoi = payload;
    }
    return { data: { id: "test" } };
  };
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); });
beforeEach(() => { memoire.clear(); redisEnPanne = false; resendEchoue = false; envoi = null; });

const poster = (items, key = KEY) => fetch(`${base}/cron/veille-presse`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(key ? { "X-Cron-Key": key } : {}) },
  body: JSON.stringify({ items })
});
const ARTICLE = { titre: "Mézières lance son application citoyenne", url: "https://www.larep.fr/article/mat?utm_source=fb#top", source: "La République du Centre", date: "2026-10-12", type: "presse", resume: "Portrait de MAT." };

test("normaliserUrl : un même article sous quatre habits n'a qu'une forme", () => {
  const a = vp.normaliserUrl("https://www.larep.fr/article/mat/?utm_source=fb&fbclid=x#top");
  assert.equal(a, "https://larep.fr/article/mat");
  assert.equal(vp.normaliserUrl("http://larep.fr/article/mat"), a);
  assert.equal(vp.normaliserUrl("javascript:alert(1)"), "");
  assert.equal(vp.normaliserUrl("pas une url"), "");
  // Un paramètre qui désigne la page (id=) est gardé : deux posts différents ne fusionnent pas.
  assert.notEqual(vp.normaliserUrl("https://x.fr/p?id=1"), vp.normaliserUrl("https://x.fr/p?id=2"));
});

test("nettoyerItems écarte ce qui n'a ni titre ni URL http(s), et une date illisible", () => {
  const r = vp.nettoyerItems([
    ARTICLE, { ...ARTICLE, url: "https://larep.fr/article/mat" }, // doublon normalisé
    { titre: "", url: "https://a.fr" }, { titre: "x", url: "ftp://a.fr" }, null,
    { titre: "Sans date", url: "https://b.fr/1", date: "12/10/2026", type: "inconnu" }
  ]);
  assert.equal(r.length, 2);
  assert.equal(r[1].date, "");
  assert.equal(r[1].type, "autre");
});

test("la route refuse sans clé, ou avec la clé en paramètre d'URL", async () => {
  assert.equal((await poster([ARTICLE], null)).status, 401);
  const r = await fetch(`${base}/cron/veille-presse?key=${KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{\"items\":[]}" });
  assert.equal(r.status, 401);
});

test("un article déjà en attente n'est pas ajouté deux fois", async () => {
  let r = await (await poster([ARTICLE])).json();
  assert.equal(r.ajoutes, 1);
  r = await (await poster([{ ...ARTICLE, url: "https://larep.fr/article/mat/" }])).json();
  assert.equal(r.ajoutes, 0);
  assert.equal(r.enAttente, 1);
});

test("Redis injoignable : 503, et rien n'est écrit", async () => {
  redisEnPanne = true;
  assert.equal((await poster([ARTICLE])).status, 503);
  redisEnPanne = false;
  assert.equal(memoire.size, 0);
});

test("le mail affiche la section puis vide la file", async () => {
  await poster([ARTICLE]);
  const r = await fetch(`${base}/cron/stats?key=${KEY}&force=1`);
  assert.equal(r.status, 200);
  assert.match(envoi.html, /Ils parlent de MAT/);
  assert.match(envoi.html, /href="https:\/\/www\.larep\.fr\/article\/mat\?utm_source=fb#top"/);
  assert.match(envoi.html, /La République du Centre/);
  assert.match(envoi.text, /ILS PARLENT DE MAT \(1\)/);
  assert.ok(!/\sclass=/i.test(envoi.html), "pas de classe CSS dans le mail (ADR-0014)");
  assert.equal(memoire.size, 0, "la file doit être vidée après l'envoi");
});

test("un mail raté garde la file pour le suivant", async () => {
  await poster([ARTICLE]);
  resendEchoue = true;
  const r = await fetch(`${base}/cron/stats?key=${KEY}&force=1`);
  assert.equal(r.status, 500);
  assert.equal((await vp.lireEnAttente()).items.length, 1);
});

test("sans rien en attente, aucune section", async () => {
  await fetch(`${base}/cron/stats?key=${KEY}&force=1`);
  assert.ok(!/Ils parlent de MAT/.test(envoi.html));
});

test("un guillemet dans une URL ne sort pas de l'attribut href", () => {
  const [it] = vp.nettoyerItems([{ titre: "x", url: 'https://a.fr/p" onmouseover="alert(1)' }]);
  assert.ok(!it.url.includes('"'));
});

test("une balise dans un titre est échappée", async () => {
  await poster([{ ...ARTICLE, titre: "<img src=x onerror=alert(1)>" }]);
  await fetch(`${base}/cron/stats?key=${KEY}&force=1`);
  assert.ok(!envoi.html.includes("<img src=x"));
});
