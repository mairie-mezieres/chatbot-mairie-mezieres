/*
 * Réponse du secrétariat à une demande sans compte Trello
 * (lib/demande-reponse.js + routes/demande-reponse.js).
 *
 * Le lien du mail est la seule autorisation : on verrouille qu'il ne vaut que
 * pour sa carte, qu'il expire, et qu'une page servie ne réinjecte jamais le
 * texte de l'habitant sans l'échapper. Trello est simulé en remplaçant les
 * méthodes d'axios (singleton) : aucun appel réseau.
 */
process.env.DEMANDE_REPLY_SECRET = "secret-de-test";
process.env.TRELLO_KEY = "k";
process.env.TRELLO_TOKEN = "t";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const dr = require("../lib/demande-reponse");
const app = require("../app");

const CARD = "0123456789abcdef01234567";
const UUID = "11111111-2222-3333-4444-555555555555";
const DESC = "Nom/prénom : Mme <b>Martin</b>\nRéponse : mm@exemple.fr · 06 12 34 56 78\n\nMessage : Bonjour,\nma poubelle <script>x</script>\n🏷️ Type : demande\n\n📅 19/10/2026\nMAT-REF: " + UUID;

// ── Jeton ─────────────────────────────────────────────────────────
test("un lien signé est accepté pour sa carte", () => {
  const v = dr.verifierLien(dr.signerLien(CARD));
  assert.deepEqual(v, { ok: true, cardId: CARD });
});

test("changer l'id de carte invalide le lien", () => {
  const [, exp, sig] = dr.signerLien(CARD).split(".");
  assert.equal(dr.verifierLien(`${"f".repeat(24)}.${exp}.${sig}`).ok, false);
});

test("repousser l'expiration invalide le lien", () => {
  const [id, exp, sig] = dr.signerLien(CARD).split(".");
  assert.equal(dr.verifierLien(`${id}.${Number(exp) + 1}.${sig}`).ok, false);
});

test("le lien expire au bout de la durée annoncée", () => {
  const t = dr.signerLien(CARD, 0);
  const apres = (dr.LIEN_VALIDITE_JOURS * 86400 + 1) * 1000;
  assert.deepEqual(dr.verifierLien(t, apres), { ok: false, raison: "expire" });
});

// ── Lecture de la demande ─────────────────────────────────────────
test("la description du formulaire de l'app est décodée", () => {
  const d = dr.lireDemande(DESC);
  assert.equal(d.nom, "Mme <b>Martin</b>");
  assert.equal(d.email, "mm@exemple.fr");
  assert.equal(d.tel, "06 12 34 56 78");
  assert.equal(d.message, "Bonjour,\nma poubelle <script>x</script>");
});

test("« Non précisé » n'est pas un nom", () => {
  assert.equal(dr.lireDemande("Nom/prénom : Non précisé\nRéponse : Non précisée\n\nMessage : x").nom, null);
});

// ── Mail ──────────────────────────────────────────────────────────
test("le mail échappe le texte de l'habitant, porte le lien et répond à l'habitant", () => {
  const m = dr.construireMail({ cardId: CARD, desc: DESC });
  assert.ok(!m.html.includes("<script>"));
  assert.ok(!m.html.includes("<b>Martin"));
  assert.ok(m.html.includes("/demande/repondre?t="));
  assert.ok(m.text.includes("/demande/repondre?t="));
  assert.equal(m.replyTo, "mm@exemple.fr");
});

test("le mail n'a ni feuille de style ni classe (ADR-0014)", () => {
  const { html } = dr.construireMail({ cardId: CARD, desc: DESC });
  assert.ok(!/<style/i.test(html));
  assert.ok(!/\sclass=/i.test(html));
});

// ── Routes ────────────────────────────────────────────────────────
let server, base;
const orig = { get: axios.get, post: axios.post, put: axios.put };
const appels = [];
let carte;

before(async () => {
  carte = { id: CARD, name: "[Demande] Mme Martin", desc: DESC, idList: "L1", idBoard: "B1", closed: false, actions: [] };
  axios.get = async (url) => {
    if (url.includes("/cards/")) return { data: carte };
    if (url.includes("/boards/")) return { data: [{ id: "L1", name: "À traiter" }, { id: "L2", name: "En cours" }, { id: "L3", name: "Résolu" }] };
    throw new Error("GET inattendu " + url);
  };
  axios.post = async (url, _b, opts) => { appels.push(["post", url, opts && opts.params]); return { data: {} }; };
  axios.put = async (url, _b, opts) => { appels.push(["put", url, opts && opts.params]); carte.idList = opts.params.idList; return { data: {} }; };
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  Object.assign(axios, orig);
  if (server) server.close();
});

test("GET sans jeton valide → 403, sans rien demander à Trello", async () => {
  const r = await fetch(base + "/demande/repondre?t=abc");
  assert.equal(r.status, 403);
});

test("GET avec le lien → page de la demande, texte échappé, non indexable", async () => {
  const r = await fetch(base + "/demande/repondre?t=" + encodeURIComponent(dr.signerLien(CARD)));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  const html = await r.text();
  assert.ok(html.includes("noindex"));
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(!html.includes("<script>x"));
});

test("un lien valide ne donne pas accès à une carte qui n'est pas une demande", async () => {
  carte.name = "[Signalement] Trou";
  const r = await fetch(base + "/demande/repondre?t=" + encodeURIComponent(dr.signerLien(CARD)));
  carte.name = "[Demande] Mme Martin";
  assert.equal(r.status, 403);
});

function poster(champs) {
  return fetch(base + "/demande/repondre", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ t: dr.signerLien(CARD), ...champs }).toString(),
  });
}

test("Répondre + clôturer → commentaire Trello puis carte dans « Résolu »", async () => {
  appels.length = 0; carte.idList = "L1";
  const r = await poster({ action: "repondre", message: "C'est noté, merci.", cloturer: "1" });
  assert.equal(r.status, 200);
  const com = appels.find(a => a[0] === "post" && a[1].endsWith("/actions/comments"));
  assert.equal(com[2].text, "C'est noté, merci.");
  assert.equal(carte.idList, "L3");
});

test("une réponse ne peut pas se faire passer pour une note interne 🔒", async () => {
  appels.length = 0;
  const r = await poster({ action: "repondre", message: "🔒 secret" });
  assert.equal(r.status, 200);
  assert.equal(appels.length, 0);
});

test("« J'ai répondu autrement » → note interne 🔒 et clôture", async () => {
  appels.length = 0; carte.idList = "L1";
  await poster({ action: "cloturer" });
  const com = appels.find(a => a[1].endsWith("/actions/comments"));
  assert.ok(com[2].text.startsWith("🔒"));
  assert.equal(carte.idList, "L3");
});

test("« En cours » → carte dans « En cours », sans commentaire", async () => {
  appels.length = 0; carte.idList = "L1";
  await poster({ action: "en_cours" });
  assert.equal(carte.idList, "L2");
  assert.ok(!appels.some(a => a[1].endsWith("/actions/comments")));
});

test("action inconnue → refusée", async () => {
  const r = await poster({ action: "supprimer" });
  assert.equal(r.status, 403);
});
