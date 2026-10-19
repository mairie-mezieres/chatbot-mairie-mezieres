// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";

// Page de réponse à une demande, ouverte depuis le mail envoyé au secrétariat
// (lib/demande-reponse.js). Aucun compte : le jeton signé du lien EST
// l'autorisation, et il ne vaut que pour sa carte.
//
// Ce que fait la page s'écrit dans Trello :
//   - « Envoyer la réponse » → commentaire sur la carte (+ clôture si cochée)
//   - « Répondu par téléphone / e-mail » → note interne 🔒 + clôture
//   - « Marquer en cours » → déplacement de la carte
// Le push à l'habitant part d'ici (pour dire au secrétariat s'il a été
// prévenu) ; le webhook Trello renvoie le même push avec le MÊME tag, que le
// téléphone remplace sans re-sonner — même schéma que PATCH /admin/signals/:id.

const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { TRELLO_KEY, TRELLO_TOKEN } = require("../config");
const { capStr } = require("../lib/validate");
const { sendDemandeCommentPush, sendDemandeStatusPush } = require("../lib/push-notify");
const {
  verifierLien, lireDemande, lireCarte, commenterCarte, deplacerCarte, esc,
} = require("../lib/demande-reponse");

// Commentaire Trello commençant par ce signe = note interne, jamais poussée à
// l'habitant (routes/trello-webhook.js).
const NOTE_INTERNE = "🔒";

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
});

const STATUT_LIBELLE = { pending: "À traiter", in_progress: "En cours", resolved: "Traitée" };

function page(titre, corps, status = 200) {
  return [status, `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(titre)} — MAT</title>
<style>
body{margin:0;background:#f5f3ee;color:#1f2937;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px}
h1{font-size:1.35rem;color:#1e3a8a;margin:8px 0 16px}
h2{font-size:1.05rem;margin:20px 0 8px}
.carte{background:#fff;border:1px solid #d1d5db;border-radius:12px;padding:14px 16px;margin:0 0 14px}
.msg{white-space:pre-wrap;background:#f3f4f6;border-radius:8px;padding:10px 12px;margin:8px 0 0}
.statut{display:inline-block;font-weight:700;padding:2px 10px;border-radius:999px;background:#e0e7ff;color:#1e3a8a}
.com{border-left:3px solid #9ca3af;padding:4px 10px;margin:6px 0;white-space:pre-wrap}
.com small{display:block;color:#4b5563}
label{display:block;font-weight:700;margin:0 0 6px}
textarea{box-sizing:border-box;width:100%;min-height:140px;font:inherit;padding:10px;border:1px solid #6b7280;border-radius:8px;background:#fff;color:#1f2937}
.case{display:flex;gap:8px;align-items:center;font-weight:400;margin:10px 0}
.case input{width:22px;height:22px}
button{font:inherit;font-weight:700;border-radius:8px;padding:12px 18px;cursor:pointer;min-height:44px}
.prim{background:#1e3a8a;color:#fff;border:0}
.sec{background:#fff;color:#1e3a8a;border:2px solid #1e3a8a}
.aide{color:#4b5563;font-size:.9rem}
.ok{background:#dcfce7;border-color:#15803d}
.ko{background:#fee2e2;border-color:#b91c1c}
:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}
</style></head><body><main>
${corps}
</main></body></html>`];
}

function envoyer(res, [status, html]) {
  res.status(status)
    .set("Cache-Control", "no-store")
    .set("Referrer-Policy", "no-referrer") // le jeton est dans l'URL
    .type("html").send(html);
}

function pageErreur(raison) {
  const msg = {
    "non-configure": "Les réponses par lien ne sont pas activées sur le serveur (DEMANDE_REPLY_SECRET manquant).",
    "expire": "Ce lien a expiré. La demande reste consultable et modifiable dans Trello.",
    "invalide": "Ce lien n'est pas valide. Utilisez le bouton du mail tel quel, sans le modifier.",
    "trello": "Trello ne répond pas pour le moment. Réessayez dans quelques minutes.",
    "introuvable": "Cette demande n'existe plus (carte supprimée dans Trello).",
  }[raison] || "Erreur inattendue.";
  return page("Lien indisponible", `<h1>Demande — lien indisponible</h1><div class="carte ko">${esc(msg)}</div>`,
    raison === "trello" ? 502 : raison === "non-configure" ? 503 : 403);
}

function _dateFr(iso) {
  try { return new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" }); }
  catch (_) { return ""; }
}

function rendreDemande(jeton, info, bandeau = "") {
  const dm = lireDemande(info.card.desc);
  const coms = info.commentaires.length
    ? info.commentaires.map(c => `<div class="com"><small>${esc(_dateFr(c.date))}${c.text.startsWith(NOTE_INTERNE) ? " · note interne, non envoyée à l'habitant" : ""}</small>${esc(c.text)}</div>`).join("")
    : `<p class="aide">Aucune réponse pour l'instant.</p>`;
  const sansPush = !info.matRef;
  return page("Répondre à une demande", `
<h1>Demande d'un habitant</h1>
${bandeau}
<div class="carte">
<p style="margin:0 0 6px">Statut : <span class="statut">${esc(STATUT_LIBELLE[info.status] || info.statusLabel)}</span></p>
<p style="margin:0"><b>Nom :</b> ${esc(dm.nom || "Non précisé")}</p>
${dm.email ? `<p style="margin:0"><b>E-mail :</b> <a href="mailto:${esc(dm.email)}">${esc(dm.email)}</a></p>` : ""}
${dm.tel ? `<p style="margin:0"><b>Téléphone :</b> <a href="tel:${esc(dm.tel.replace(/[\s.\-]/g, ""))}">${esc(dm.tel)}</a></p>` : ""}
<div class="msg">${esc(dm.message)}</div>
</div>
<h2>Réponses déjà apportées</h2>
<div class="carte">${coms}</div>
<h2>Répondre dans l'application</h2>
<form method="post" action="/demande/repondre" class="carte">
<input type="hidden" name="t" value="${esc(jeton)}">
<input type="hidden" name="action" value="repondre">
<label for="message">Votre réponse</label>
<textarea id="message" name="message" maxlength="2000" required aria-describedby="aide-msg"></textarea>
<p id="aide-msg" class="aide">${sansPush
    ? "⚠️ Cette demande n'est pas reliée à un téléphone : l'habitant ne recevra pas de notification. Préférez le téléphone ou l'e-mail."
    : "L'habitant la reçoit en notification sur son téléphone. Elle est aussi enregistrée dans Trello."}</p>
<label class="case"><input type="checkbox" name="cloturer" value="1" checked> Clôturer la demande après l'envoi</label>
<button class="prim" type="submit">Envoyer la réponse</button>
</form>
<h2>Autres actions</h2>
<form method="post" action="/demande/repondre" class="carte">
<input type="hidden" name="t" value="${esc(jeton)}">
<input type="hidden" name="action" value="cloturer">
<p class="aide" style="margin-top:0">Vous avez répondu par téléphone, par e-mail ou au guichet : la demande est clôturée et l'habitant est prévenu qu'elle a été traitée.</p>
<button class="sec" type="submit">J'ai répondu autrement — clôturer</button>
</form>
<form method="post" action="/demande/repondre" class="carte">
<input type="hidden" name="t" value="${esc(jeton)}">
<input type="hidden" name="action" value="en_cours">
<p class="aide" style="margin-top:0">La demande est prise en charge mais pas encore réglée : l'habitant est prévenu qu'elle est en cours.</p>
<button class="sec" type="submit">Marquer « en cours »</button>
</form>`);
}

async function _charger(jeton, res) {
  const v = verifierLien(jeton);
  if (!v.ok) { envoyer(res, pageErreur(v.raison)); return null; }
  if (!TRELLO_KEY || !TRELLO_TOKEN) { envoyer(res, pageErreur("trello")); return null; }
  try {
    const info = await lireCarte(v.cardId);
    // Le jeton est signé pour cette carte, mais on ne sert que des demandes.
    if (!String(info.card.name || "").startsWith("[Demande]")) { envoyer(res, pageErreur("invalide")); return null; }
    return info;
  } catch (e) {
    const st = e.response && e.response.status;
    envoyer(res, pageErreur(st === 404 ? "introuvable" : "trello"));
    return null;
  }
}

router.get("/demande/repondre", limiter, async (req, res) => {
  const jeton = String(req.query.t || "");
  const info = await _charger(jeton, res);
  if (info) envoyer(res, rendreDemande(jeton, info));
});

router.post("/demande/repondre", limiter, express.urlencoded({ extended: false, limit: "32kb" }), async (req, res) => {
  const body = req.body || {};
  const jeton = String(body.t || "");
  const action = String(body.action || "");
  if (!["repondre", "cloturer", "en_cours"].includes(action)) return envoyer(res, pageErreur("invalide"));
  const info = await _charger(jeton, res);
  if (!info) return;
  const cardId = info.card.id;
  const faits = [];
  let pushRes = null;
  try {
    if (action === "repondre") {
      const message = capStr(body.message, 2000).trim();
      if (!message) {
        return envoyer(res, rendreDemande(jeton, info, `<div class="carte ko">Le message est vide : rien n'a été envoyé.</div>`));
      }
      if (message.startsWith(NOTE_INTERNE)) {
        return envoyer(res, rendreDemande(jeton, info, `<div class="carte ko">Une réponse ne peut pas commencer par ${NOTE_INTERNE} : ce signe marque les notes internes, qui ne sont pas envoyées à l'habitant.</div>`));
      }
      await commenterCarte(cardId, message);
      faits.push("Réponse enregistrée dans Trello.");
      if (info.matRef) pushRes = await sendDemandeCommentPush(info.matRef, message, cardId).catch(e => ({ skipped: true, reason: e.message }));
      if (body.cloturer) {
        await deplacerCarte(info, "resolved");
        faits.push("Demande clôturée.");
      }
    } else if (action === "cloturer") {
      await commenterCarte(cardId, `${NOTE_INTERNE} Réponse apportée hors de l'application (téléphone, e-mail ou guichet) — clôturée depuis le lien du mail.`);
      const bouge = await deplacerCarte(info, "resolved");
      faits.push("Demande clôturée.");
      if (bouge && info.matRef) pushRes = await sendDemandeStatusPush(info.matRef, "resolved", cardId).catch(e => ({ skipped: true, reason: e.message }));
    } else {
      const bouge = await deplacerCarte(info, "in_progress");
      faits.push(bouge ? "Demande marquée « en cours »." : "La demande était déjà « en cours ».");
      if (bouge && info.matRef) pushRes = await sendDemandeStatusPush(info.matRef, "in_progress", cardId).catch(e => ({ skipped: true, reason: e.message }));
    }
  } catch (e) {
    console.warn("📩 /demande/repondre:", (e.response && JSON.stringify(e.response.data)) || e.message);
    const msg = e.code === "NO_LIST"
      ? `${e.message} : renommez une liste du tableau Trello (ex. « En cours », « Résolu »).`
      : "Trello n'a pas pu enregistrer l'action. Réessayez dans quelques minutes.";
    const fait = faits.length ? ` Déjà fait : ${faits.join(" ")}` : "";
    return envoyer(res, page("Erreur", `<h1>Demande d'un habitant</h1><div class="carte ko">${esc(msg + fait)}</div>`, 502));
  }
  console.log(`📩 Demande ${cardId} — ${action} — push:`, pushRes);

  let notif;
  if (pushRes && pushRes.sent) notif = "L'habitant a reçu une notification sur son téléphone.";
  else if (pushRes || (action === "repondre" && !info.matRef)) notif = "⚠️ L'habitant n'a pas pu être notifié sur son téléphone (notifications désactivées ou expirées). S'il a laissé un e-mail ou un téléphone, contactez-le directement.";
  else notif = "";
  const bandeau = `<div class="carte ok" role="status">${esc(faits.join(" "))}${notif ? `<br>${esc(notif)}` : ""}</div>`;
  // Relecture pour afficher l'état à jour ; à défaut, le bandeau suffit.
  let ajour = info;
  try { ajour = await lireCarte(cardId); } catch (_) {}
  envoyer(res, rendreDemande(jeton, ajour, bandeau));
});

module.exports = router;
