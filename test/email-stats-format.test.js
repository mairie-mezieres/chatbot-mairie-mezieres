/*
 * Le mail de stats quotidien doit rester lisible dans un client de messagerie.
 *
 * Contexte : le gabarit d'origine posait toute sa mise en forme dans un bloc
 * <style> du <head> et la référençait par des classes. Une bonne partie des
 * clients (Gmail selon le type de compte, Outlook.com, Yahoo, applis mobiles)
 * supprime ce bloc : le mail arrivait alors sans aucune mise en forme, donc
 * en texte brut. Ces contrôles verrouillent les trois règles qui l'évitent —
 * styles en attribut, mise en page en <table>, et une vraie variante texte.
 *
 * Aucun appel réseau réel : axios.post est intercepté avant l'envoi Resend.
 *
 * Lancer : node test/email-stats-format.test.js (ou npm test)
 */
process.env.RESEND_API_KEY   = process.env.RESEND_API_KEY   || "test-key";
process.env.DAILY_STATS_EMAIL = process.env.DAILY_STATS_EMAIL || "test@example.invalid";
process.env.CRON_SECRET      = process.env.CRON_SECRET      || "test-cron-secret";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const axios = require("axios");
const app = require("../app");

let server, base, sent;

before(async () => {
  axios.post = async (url, payload) => {
    if (String(url).includes("resend")) sent = payload;
    return { data: { id: "test" } };
  };
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/cron/stats?key=${process.env.CRON_SECRET}&force=1`);
  assert.equal(r.status, 200, "l'envoi du mail de stats doit aboutir");
  assert.ok(sent, "aucun payload transmis à Resend");
});

after(() => { if (server) server.close(); });

test("le mail porte bien un corps HTML et un sujet", () => {
  assert.match(sent.subject, /MAT/);
  assert.match(sent.html, /^<!DOCTYPE html>/);
});

test("aucun bloc <style> : il est supprimé par les clients de messagerie", () => {
  assert.ok(!/<style[\s>]/i.test(sent.html), "un bloc <style> est réapparu dans le gabarit");
});

test("aucune classe CSS : sans feuille de style, elle ne peint rien", () => {
  assert.ok(!/\sclass=/i.test(sent.html), "un attribut class= est réapparu dans le gabarit");
});

test("aucun display:grid ni flex : ignorés par Outlook", () => {
  assert.ok(!/display\s*:\s*(grid|flex)/i.test(sent.html), "une mise en page grid/flex est réapparue");
});

test("les couleurs de la charte sont bien inscrites en attribut style", () => {
  assert.match(sent.html, /style="[^"]*background:#f4f0ea/);   // fond de page
  assert.match(sent.html, /style="[^"]*color:#1a3d2b/);        // vert foncé des titres
  assert.match(sent.html, /style="[^"]*background:#d8f3dc/);   // pastilles de chiffres
});

test("les cellules de texte portent leur propre famille de police", () => {
  // Sans feuille de style, l'héritage depuis <body> ne suffit pas sous Outlook.
  const cells = sent.html.match(/<td[^>]*>/g) || [];
  assert.ok(cells.filter(td => /font-family/.test(td)).length >= 4,
    "les pastilles de chiffres doivent déclarer leur police");
  for (const td of cells) {
    if (/font-size/.test(td)) assert.match(td, /font-family/, `cellule dimensionnée sans police : ${td}`);
  }
});

test("une variante texte lisible accompagne le HTML", () => {
  assert.equal(typeof sent.text, "string");
  assert.ok(!/[<>]/.test(sent.text), "la variante texte ne doit contenir aucune balise");
  assert.match(sent.text, /MAT — Statistiques du /);
  assert.match(sent.text, /FRÉQUENTATION/);
  assert.match(sent.text, /ABONNEMENTS PUSH/);
  assert.match(sent.text, /REDIS UPSTASH/);
});
