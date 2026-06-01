// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const crypto = require("crypto");
const { TRELLO_KEY, TRELLO_TOKEN, TRELLO_LIST_ID_SIG, TRELLO_LIST_ID_BUG } = require("../config");
const { trelloStatusFromListName } = require("../lib/trello-status");
const { sendSignalStatusPush, SIGNAL_STATUS_PUSH, sendDemandeStatusPush, sendDemandeCommentPush } = require("../lib/push-notify");
const { adminAuth } = require("../lib/middleware");

// Secret optionnel pour valider la signature HMAC-SHA1 envoyée par Trello.
// (Trello → "App Secret" / "OAuth Secret" sur https://trello.com/app-key)
const TRELLO_WEBHOOK_SECRET = process.env.TRELLO_WEBHOOK_SECRET || process.env.TRELLO_SECRET || "";

// Trello vérifie le callback via une requête HEAD lors de la création du webhook.
router.head("/trello/webhook", (req, res) => res.sendStatus(200));
router.get("/trello/webhook", (req, res) => res.sendStatus(200));

router.post("/trello/webhook", async (req, res) => {
  // Validation de signature si le secret est configuré (sinon: fonctionnel
  // mais non authentifié — recommandé de définir TRELLO_WEBHOOK_SECRET).
  if (TRELLO_WEBHOOK_SECRET) {
    const sig = req.headers["x-trello-webhook"];
    // Trello signe avec l'URL de callback enregistrée = notre propre URL.
    const callback = process.env.TRELLO_WEBHOOK_CALLBACK ||
      `${req.protocol}://${req.get("host")}/trello/webhook`;
    const base = (req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {})) + callback;
    const expected = crypto.createHmac("sha1", TRELLO_WEBHOOK_SECRET).update(base).digest("base64");
    if (!sig || sig !== expected) {
      console.warn("⚠️ Trello webhook: signature invalide");
      return res.sendStatus(401);
    }
  }
  res.sendStatus(200); // ACK immédiat — Trello exige une réponse rapide
  try {
    await handleTrelloAction(req.body && req.body.action);
  } catch (e) {
    console.warn("Trello webhook handler:", e.message);
  }
});

async function handleTrelloAction(action) {
  if (!action) return;

  if (action.type === "commentCard") {
    await handleTrelloComment(action);
    return;
  }

  if (action.type !== "updateCard") return;
  const data = action.data || {};
  // On ne réagit qu'aux déplacements de carte d'une liste à une autre.
  if (!data.listBefore || !data.listAfter) return;
  const prevStatus = trelloStatusFromListName(data.listBefore.name);
  const newStatus = trelloStatusFromListName(data.listAfter.name);
  if (prevStatus === newStatus) return;        // même catégorie de statut → rien
  if (!SIGNAL_STATUS_PUSH[newStatus]) return;  // on ne notifie pas le retour "pending"

  const cardId = data.card && data.card.id;
  const cardName = data.card && data.card.name;
  if (!cardId) return;

  // Le payload Trello ne contient pas la description : on la refetch pour
  // lire le marqueur MAT-REF (le notifyToken du citoyen).
  const desc = await fetchCardDesc(cardId);
  const m = (desc || "").match(/MAT-REF:\s*([a-f0-9-]{36})/i);
  if (!m) return; // carte non issue de MAT (ou ancienne, sans token)

  const isDemandeCard = cardName && cardName.startsWith("[Demande]");
  const r = isDemandeCard
    ? await sendDemandeStatusPush(m[1], newStatus, cardId)
    : await sendSignalStatusPush(m[1], newStatus, cardId);
  console.log(`🔔 Trello ${prevStatus}→${newStatus} carte ${cardId} — push:`, r);
}

async function handleTrelloComment(action) {
  const data = action.data || {};
  const cardId = data.card && data.card.id;
  const cardName = data.card && data.card.name;
  // Uniquement pour les cartes de type [Demande]
  if (!cardId || !cardName || !cardName.startsWith("[Demande]")) return;

  const commentText = data.text || "";
  const desc = await fetchCardDesc(cardId);
  const m = (desc || "").match(/MAT-REF:\s*([a-f0-9-]{36})/i);
  if (!m) return;

  const r = await sendDemandeCommentPush(m[1], commentText, cardId);
  console.log(`🔔 Trello commentaire demande ${cardId} — push:`, r);
}

async function fetchCardDesc(cardId) {
  if (!TRELLO_KEY || !TRELLO_TOKEN) return null;
  const url = `https://api.trello.com/1/cards/${encodeURIComponent(cardId)}` +
    `?fields=desc&key=${encodeURIComponent(TRELLO_KEY)}&token=${encodeURIComponent(TRELLO_TOKEN)}`;
  const r = await axios.get(url, { timeout: 8000 });
  return r.data && r.data.desc;
}

// ── Administration des webhooks Trello ────────────────────────
async function _boardIdForList(listId) {
  const url = `https://api.trello.com/1/lists/${encodeURIComponent(listId)}` +
    `?fields=idBoard&key=${encodeURIComponent(TRELLO_KEY)}&token=${encodeURIComponent(TRELLO_TOKEN)}`;
  const r = await axios.get(url, { timeout: 8000 });
  return r.data && r.data.idBoard;
}

// Enregistre (idempotent côté Trello) un webhook sur chaque board portant
// les listes SIG / BUG. À appeler une fois après déploiement.
router.post("/admin/trello/register-webhook", adminAuth, async (req, res) => {
  if (!TRELLO_KEY || !TRELLO_TOKEN) return res.status(503).json({ error: "Trello non configuré" });
  // URL de callback : 1) override explicite, 2) variable d'env, 3) auto-détectée
  // à partir de la requête entrante (le serveur connaît sa propre URL publique).
  const selfUrl = `${req.protocol}://${req.get("host")}/trello/webhook`;
  const callbackURL = (req.body && req.body.callbackURL) ||
    process.env.TRELLO_WEBHOOK_CALLBACK || selfUrl;
  try {
    const boardIds = new Set();
    for (const listId of [TRELLO_LIST_ID_SIG, TRELLO_LIST_ID_BUG]) {
      if (listId) boardIds.add(await _boardIdForList(listId));
    }
    if (!boardIds.size) return res.status(400).json({ error: "Aucune liste SIG/BUG configurée" });
    const results = [];
    for (const idModel of boardIds) {
      try {
        const r = await axios.post("https://api.trello.com/1/webhooks", null, {
          params: { key: TRELLO_KEY, token: TRELLO_TOKEN, callbackURL, idModel, description: "MAT — statut signalements" },
          timeout: 15000
        });
        results.push({ idModel, ok: true, id: r.data.id });
      } catch (e) {
        const err = (e.response && e.response.data) || e.message;
        // Trello renvoie une 400 si le webhook existe déjà — considéré OK.
        const already = typeof err === "string" && /already exists/i.test(err);
        results.push({ idModel, ok: already, alreadyExists: already, error: already ? undefined : err });
      }
    }
    res.json({ callbackURL, signatureCheck: !!TRELLO_WEBHOOK_SECRET, results });
  } catch (e) {
    res.status(500).json({ error: (e.response && e.response.data) || e.message });
  }
});

// Liste les webhooks attachés au token courant (debug / nettoyage).
router.get("/admin/trello/webhooks", adminAuth, async (req, res) => {
  if (!TRELLO_KEY || !TRELLO_TOKEN) return res.status(503).json({ error: "Trello non configuré" });
  try {
    const url = `https://api.trello.com/1/tokens/${encodeURIComponent(TRELLO_TOKEN)}/webhooks` +
      `?key=${encodeURIComponent(TRELLO_KEY)}&token=${encodeURIComponent(TRELLO_TOKEN)}`;
    const r = await axios.get(url, { timeout: 8000 });
    res.json({ webhooks: r.data });
  } catch (e) {
    res.status(500).json({ error: (e.response && e.response.data) || e.message });
  }
});

router.delete("/admin/trello/webhooks/:id", adminAuth, async (req, res) => {
  if (!TRELLO_KEY || !TRELLO_TOKEN) return res.status(503).json({ error: "Trello non configuré" });
  try {
    await axios.delete(`https://api.trello.com/1/webhooks/${encodeURIComponent(req.params.id)}`, {
      params: { key: TRELLO_KEY, token: TRELLO_TOKEN }, timeout: 8000
    });
    res.json({ ok: true, deleted: req.params.id });
  } catch (e) {
    res.status(500).json({ error: (e.response && e.response.data) || e.message });
  }
});

module.exports = router;
