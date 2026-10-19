// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";

// Réponse aux demandes « Contacter la mairie » SANS compte Trello.
//
// Le secrétariat n'a pas accès à Trello. Chaque nouvelle demande part donc par
// mail à l'adresse de la mairie (DEMANDE_EMAIL), avec un lien signé vers une
// page de réponse (routes/demande-reponse.js). Ce qui est fait sur cette page
// est écrit DANS la carte Trello (commentaire, changement de liste) : Trello
// reste la seule source de vérité, et l'habitant est notifié comme si la
// réponse avait été tapée dans Trello.
//
// Le lien ne donne accès qu'à UNE carte : le jeton est un HMAC de son id et de
// sa date d'expiration, sans état côté serveur (aucune clé Redis).

const crypto = require("crypto");
const axios = require("axios");
const { TRELLO_KEY, TRELLO_TOKEN, RESEND_API_KEY } = require("../config");
const { trelloStatusFromListName } = require("./trello-status");

const DEMANDE_EMAIL        = process.env.DEMANDE_EMAIL || "";
const DEMANDE_REPLY_SECRET = process.env.DEMANDE_REPLY_SECRET || "";
const BACKEND_PUBLIC_URL   = (process.env.BACKEND_PUBLIC_URL || "https://chatbot-mairie-mezieres.onrender.com").replace(/\/+$/, "");
// Une demande traînant plus longtemps se traite dans Trello : un lien de mail
// ne doit pas rester une clé valable indéfiniment.
const LIEN_VALIDITE_JOURS  = 60;

const CARD_ID_RE = /^[a-f0-9]{24}$/;

function _hmac(payload) {
  return crypto.createHmac("sha256", DEMANDE_REPLY_SECRET).update(payload).digest("base64url");
}

function signerLien(cardId, now = Date.now()) {
  if (!DEMANDE_REPLY_SECRET || !CARD_ID_RE.test(String(cardId || ""))) return null;
  const exp = Math.floor(now / 1000) + LIEN_VALIDITE_JOURS * 86400;
  const payload = `${cardId}.${exp}`;
  return `${payload}.${_hmac(payload)}`;
}

// → { ok: true, cardId } | { ok: false, raison }
function verifierLien(jeton, now = Date.now()) {
  if (!DEMANDE_REPLY_SECRET) return { ok: false, raison: "non-configure" };
  const parts = String(jeton || "").split(".");
  if (parts.length !== 3) return { ok: false, raison: "invalide" };
  const [cardId, expStr, sig] = parts;
  if (!CARD_ID_RE.test(cardId) || !/^\d{1,12}$/.test(expStr)) return { ok: false, raison: "invalide" };
  const attendu = Buffer.from(_hmac(`${cardId}.${expStr}`));
  const recu = Buffer.from(sig);
  if (recu.length !== attendu.length || !crypto.timingSafeEqual(recu, attendu)) return { ok: false, raison: "invalide" };
  if (Number(expStr) * 1000 < now) return { ok: false, raison: "expire" };
  return { ok: true, cardId };
}

function urlReponse(cardId) {
  const t = signerLien(cardId);
  return t ? `${BACKEND_PUBLIC_URL}/demande/repondre?t=${encodeURIComponent(t)}` : null;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// La description vient du formulaire de l'app (js/mat-forms.js) :
//   Nom/prénom : …\nRéponse : <mail> · <tél>\n\nMessage : …
function lireDemande(desc) {
  const d = String(desc || "");
  const nom = (d.match(/^Nom\/pr[eé]nom\s*:\s*(.+)$/m) || [])[1];
  const contact = (d.match(/^R[eé]ponse\s*:\s*(.+)$/m) || [])[1] || "";
  const msg = (d.match(/\n\nMessage\s*:\s*([\s\S]*?)(?:\n?🏷️ Type|\nMAT-REF:|$)/) || [])[1];
  const email = (contact.match(/[^\s@·]+@[^\s@·]+\.[^\s@·]{2,}/) || [])[0] || null;
  const tel = (contact.match(/(?:\d[\s.\-]?){10}/) || [])[0] || null;
  return {
    nom: nom && nom.trim() !== "Non précisé" ? nom.trim() : null,
    email,
    tel: tel ? tel.trim() : null,
    message: (msg || d).replace(/\nMAT-REF:.*$/m, "").trim(),
  };
}

// ── Mail au secrétariat ─────────────────────────────────────────
// ⛔ Pas de feuille de style ni de classe (ADR-0014) : styles en attribut,
// mise en page en <table>, variante texte.
function construireMail({ cardId, desc }) {
  const dm = lireDemande(desc);
  const lien = urlReponse(cardId);
  const qui = dm.nom || "Un habitant";
  const subject = `📩 Demande d'un habitant — ${qui}`.replace(/[\r\n]+/g, " ").substring(0, 150);
  const td = 'style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2937;padding:6px 0"';
  const ligne = (lib, val) => val
    ? `<tr><td ${td}><b>${esc(lib)} :</b> ${esc(val)}</td></tr>` : "";
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;color:#1e3a8a;padding:0 0 12px">Nouvelle demande depuis l'application MAT</td></tr>
${ligne("Nom", dm.nom || "Non précisé")}
${ligne("E-mail", dm.email)}
${ligne("Téléphone", dm.tel)}
${!dm.email && !dm.tel ? `<tr><td ${td}><i>L'habitant n'a laissé ni e-mail ni téléphone.</i></td></tr>` : ""}
<tr><td ${td}><b>Message :</b></td></tr>
<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2937;background:#f3f4f6;padding:12px;border-radius:8px;white-space:pre-wrap">${esc(dm.message)}</td></tr>
${lien ? `<tr><td style="padding:20px 0 8px"><a href="${esc(lien)}" style="display:inline-block;background:#1e3a8a;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:8px">Répondre ou clôturer la demande</a></td></tr>
<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#4b5563;padding:4px 0">Ce bouton permet d'écrire une réponse, qui est envoyée à l'habitant dans l'application, ou d'indiquer que vous lui avez répondu par téléphone ou par e-mail. Lien personnel, valable ${LIEN_VALIDITE_JOURS} jours : ne le transférez pas.</td></tr>` : ""}
${dm.email ? `<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#4b5563;padding:4px 0">« Répondre » dans votre messagerie écrit directement à l'habitant. Pensez ensuite à clôturer la demande avec le bouton ci-dessus.</td></tr>` : ""}
</table>`;
  const text = [
    "Nouvelle demande depuis l'application MAT", "",
    `Nom : ${dm.nom || "Non précisé"}`,
    ...(dm.email ? [`E-mail : ${dm.email}`] : []),
    ...(dm.tel ? [`Téléphone : ${dm.tel}`] : []),
    ...(!dm.email && !dm.tel ? ["L'habitant n'a laissé ni e-mail ni téléphone."] : []),
    "", "Message :", dm.message, "",
    ...(lien ? [`Répondre ou clôturer la demande : ${lien}`, `(lien personnel, valable ${LIEN_VALIDITE_JOURS} jours)`] : []),
  ].join("\n");
  return { subject, html, text, replyTo: dm.email };
}

// Même adresse vérifiée chez Resend que le mail de stats, autre nom affiché :
// « MAT Stats » en tête d'une demande d'habitant prêterait à confusion.
function expediteur() {
  const adr = ((process.env.RESEND_FROM || "").match(/<([^>]+)>/) || [])[1]
    || (process.env.RESEND_FROM || "").trim() || "onboarding@resend.dev";
  return `MAT — Demandes <${adr}>`;
}

async function envoyerMailDemande({ cardId, desc }) {
  if (!DEMANDE_EMAIL) return { skipped: true, reason: "DEMANDE_EMAIL non configuré" };
  if (!RESEND_API_KEY) return { skipped: true, reason: "RESEND_API_KEY non configuré" };
  if (!DEMANDE_REPLY_SECRET) console.warn("⚠️ DEMANDE_REPLY_SECRET absent : mail de demande envoyé SANS lien de réponse");
  const m = construireMail({ cardId, desc });
  await axios.post("https://api.resend.com/emails", {
    from: expediteur(),
    to: DEMANDE_EMAIL.split(",").map(s => s.trim()).filter(Boolean),
    subject: m.subject, html: m.html, text: m.text,
    ...(m.replyTo ? { reply_to: m.replyTo } : {}),
  }, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    timeout: 15000,
  });
  return { sent: true };
}

// ── Trello ──────────────────────────────────────────────────────
function _tp() { return { key: TRELLO_KEY, token: TRELLO_TOKEN }; }

async function lireCarte(cardId) {
  const r = await axios.get(`https://api.trello.com/1/cards/${encodeURIComponent(cardId)}`, {
    params: { ..._tp(), fields: "name,desc,idList,idBoard,closed", actions: "commentCard" }, timeout: 10000,
  });
  const card = r.data;
  const lists = (await axios.get(`https://api.trello.com/1/boards/${card.idBoard}/lists`, {
    params: { ..._tp(), fields: "id,name", filter: "open" }, timeout: 10000,
  })).data;
  const liste = lists.find(l => l.id === card.idList);
  return {
    card, lists,
    status: card.closed ? "resolved" : trelloStatusFromListName(liste && liste.name),
    statusLabel: card.closed ? "Archivée" : (liste ? liste.name : "?"),
    commentaires: (card.actions || []).filter(a => a.type === "commentCard")
      .map(a => ({ text: (a.data && a.data.text) || "", date: a.date })).reverse(),
    matRef: ((card.desc || "").match(/MAT-REF:\s*([a-f0-9-]{36})/i) || [])[1] || null,
  };
}

async function commenterCarte(cardId, texte) {
  await axios.post(`https://api.trello.com/1/cards/${encodeURIComponent(cardId)}/actions/comments`, null, {
    params: { ..._tp(), text: texte }, timeout: 10000,
  });
}

// Déplace la carte vers la première liste du tableau dont le nom correspond au
// statut (même règle que PATCH /admin/signals/:id). → true si déplacée.
async function deplacerCarte(info, status) {
  const cible = info.lists.find(l => trelloStatusFromListName(l.name) === status);
  if (!cible) {
    const err = new Error(`Aucune liste Trello ne correspond au statut « ${status} »`);
    err.code = "NO_LIST";
    throw err;
  }
  if (cible.id === info.card.idList) return false;
  await axios.put(`https://api.trello.com/1/cards/${encodeURIComponent(info.card.id)}`, null, {
    params: { ..._tp(), idList: cible.id }, timeout: 10000,
  });
  return true;
}

module.exports = {
  signerLien, verifierLien, urlReponse, expediteur, lireDemande, construireMail, envoyerMailDemande,
  lireCarte, commenterCarte, deplacerCarte, esc, LIEN_VALIDITE_JOURS,
};
