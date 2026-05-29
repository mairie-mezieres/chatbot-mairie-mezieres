// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { readSignals, writeSignals } = require("../lib/store");
const { adminAuth } = require("../lib/middleware");
const { TRELLO_KEY, TRELLO_TOKEN, TRELLO_LIST_ID_SIG, TRELLO_LIST_ID_BUG, TRELLO_NOTIFY } = require("../config");
const { registerNotifyToken, sendPushToToken } = require("../lib/push-notify");
const { trelloStatusFromListName } = require("../lib/trello-status");

const SIGNAL_STATUS_PUSH = {
  in_progress: { title: "🔵 Votre signalement est en cours de traitement", body: "La mairie a pris en compte votre signalement." },
  resolved:    { title: "✅ Votre signalement a été résolu", body: "La mairie a traité votre signalement. Merci pour votre contribution !" }
};

const signalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Trop de signalements, patientez avant de réessayer." }
});

// ── Création carte Trello ─────────────────────────────────────
async function createTrelloCard(type, name, desc, photoB64, matRef = null) {
  if (!TRELLO_KEY || !TRELLO_TOKEN) {
    console.warn("⚠️ Trello non configuré — clé/token manquants");
    return null;
  }

  const cfg = TRELLO_NOTIFY[type];
  if (!cfg || !cfg.listId) {
    console.warn(`⚠️ Trello non configuré pour le type "${type}"`);
    return null;
  }

  // 1. Créer la carte dans la bonne liste + affecter les membres
  const cardRes = await axios.post(
    "https://api.trello.com/1/cards",
    null,
    {
      params: {
        key: TRELLO_KEY,
        token: TRELLO_TOKEN,
        idList: cfg.listId,
        name: String(name || "Sans titre").substring(0, 512),
        desc: (String(desc || "") + (matRef ? `\nMAT-REF: ${matRef}` : "")).substring(0, 16384),
        pos: "top",
        ...(cfg.memberIds.length ? { idMembers: cfg.memberIds.join(",") } : {})
      },
      timeout: 15000,
    }
  );

  const card = cardRes.data;
  console.log(`✅ Trello carte créée: ${card.id} — ${card.shortUrl}`);

  // 2. Attacher la photo si présente
  if (photoB64 && photoB64.startsWith("data:image")) {
    try {
      const matches = photoB64.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (matches) {
        const mimeType = matches[1];
        const ext = mimeType.split("/")[1].replace("jpeg", "jpg") || "jpg";
        const buffer = Buffer.from(matches[2], "base64");

        const FormData = require("form-data");
        const form = new FormData();
        form.append("file", buffer, {
          filename: `photo.${ext}`,
          contentType: mimeType
        });
        form.append("name", `photo.${ext}`);
        form.append("mimeType", mimeType);

        await axios.post(
          `https://api.trello.com/1/cards/${card.id}/attachments`,
          form,
          {
            params: { key: TRELLO_KEY, token: TRELLO_TOKEN },
            headers: form.getHeaders(),
            timeout: 30000,
            maxBodyLength: 10 * 1024 * 1024,
          }
        );
        console.log(`📎 Photo attachée à la carte Trello ${card.id}`);
      }
    } catch (attachErr) {
      console.warn("⚠️ Échec attachement photo Trello:", attachErr.message);
    }
  }

  return card;
}

// ── Suivi public des signalements via Trello ──────────────────
function _anonymize(text) {
  if (!text) return '';
  let t = text
    .replace(/\n+📱[^\n]*/g, '')
    .replace(/\n+🏷️[^\n]*/g, '')
    .replace(/\n+Appareil\s*:[^\n]*/g, '')
    .replace(/\n+Modèle\s*:[^\n]*/g, '')
    .replace(/\n+OS\s*:[^\n]*/g, '')
    .replace(/\n+Navigateur\s*:[^\n]*/g, '')
    .replace(/\n+Écran\s*:[^\n]*/g, '')
    .replace(/\n+PWA\s*:[^\n]*/g, '')
    .replace(/\n+MAT\s*:[^\n]*/g, '')
    .replace(/\n+Description\s*:\n*/g, '\n')
    .trim();
  return t
    .replace(/\b0[1-9](?:[\s.\-]?\d{2}){4}\b/g, '[tél. masqué]')
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[email masqué]');
}

async function _trelloGet(path) {
  if (!TRELLO_KEY || !TRELLO_TOKEN) throw new Error('Trello non configuré');
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.trello.com/1${path}${sep}key=${encodeURIComponent(TRELLO_KEY)}&token=${encodeURIComponent(TRELLO_TOKEN)}`;
  const r = await axios.get(url, { timeout: 8000 });
  return r.data;
}

const _trelloBoardIdCache = {};
async function _trelloBoardIdFor(listId) {
  if (_trelloBoardIdCache[listId]) return _trelloBoardIdCache[listId];
  const list = await _trelloGet(`/lists/${listId}?fields=idBoard`);
  _trelloBoardIdCache[listId] = list.idBoard;
  return list.idBoard;
}

const _attachmentUrlMap = new Map();
let _sigTrackCache = null, _sigTrackCacheAt = 0;

async function _fetchTrelloSignalements() {
  if (_sigTrackCache && Date.now() - _sigTrackCacheAt < 5 * 60 * 1000) return _sigTrackCache;
  if (!TRELLO_KEY || !TRELLO_TOKEN) return { signalements: [], bugs: [] };
  _attachmentUrlMap.clear();
  // Support SIG et BUG sur des boards Trello séparés
  const boardIds = new Set();
  if (TRELLO_LIST_ID_SIG) boardIds.add(await _trelloBoardIdFor(TRELLO_LIST_ID_SIG));
  if (TRELLO_LIST_ID_BUG) boardIds.add(await _trelloBoardIdFor(TRELLO_LIST_ID_BUG));
  if (!boardIds.size) return { signalements: [], bugs: [] };
  const listStatusMap = {}, listNameMap = {};
  const allCards = [];
  await Promise.all([...boardIds].map(async bid => {
    const [lists, cards] = await Promise.all([
      _trelloGet(`/boards/${bid}/lists?fields=id,name&filter=open`),
      _trelloGet(`/boards/${bid}/cards?filter=open&fields=id,name,desc,idList,dateLastActivity&attachments=true&actions=commentCard`),
    ]);
    for (const l of lists) { listStatusMap[l.id] = trelloStatusFromListName(l.name); listNameMap[l.id] = l.name; }
    allCards.push(...cards);
  }));
  // Compatibility: replace local cards variable reference
  const cards = allCards;
  const result = { signalements: [], bugs: [] };
  for (const card of cards) {
    const isSig = card.name.startsWith('[Signalement]');
    const isBug = card.name.startsWith('[BUG]');
    if (!isSig && !isBug) continue;
    const cat = card.name.replace(/^\[(Signalement|BUG)\]\s*/, '');
    const status = listStatusMap[card.idList] || 'pending';
    const statusLabel = listNameMap[card.idList] || 'À traiter';
    const comments = ((card.actions || [])
      .filter(a => a.type === 'commentCard')
      .map(a => ({ text: _anonymize(a.data.text), date: a.date }))
    ).reverse();
    const photos = (card.attachments || [])
      .filter(a => a.id && a.url && (!a.mimeType || a.mimeType.startsWith('image/')))
      .map(a => {
        const prvs = (a.previews || []).filter(p => p.url).sort((x, y) => (y.width || 0) - (x.width || 0));
        _attachmentUrlMap.set(`${card.id}/${a.id}`, { trelloUrl: a.url, previewUrl: prvs.length ? prvs[0].url : null, cachedAt: Date.now(), mimeType: a.mimeType || 'image/jpeg' });
        return { url: `https://chatbot-mairie-mezieres.onrender.com/api/signalements/photo/${card.id}/${a.id}` };
      });
    const matRefMatch = (card.desc || '').match(/\nMAT-REF:\s*([a-f0-9-]{36})/i);
    const matRef = matRefMatch ? matRefMatch[1] : null;
    const descNoRef = (card.desc || '').replace(/\nMAT-REF:\s*[a-f0-9-]{36}/gi, '');
    const item = { id: card.id, cat, desc: _anonymize(descNoRef), status, statusLabel, date: card.dateLastActivity, comments, photos, ...(matRef ? { matRef } : {}) };
    if (isSig) result.signalements.push(item);
    else result.bugs.push(item);
  }
  result.signalements.sort((a, b) => b.date.localeCompare(a.date));
  result.bugs.sort((a, b) => b.date.localeCompare(a.date));
  _sigTrackCache = result; _sigTrackCacheAt = Date.now();
  return result;
}

// ── Signalement citoyen → Redis + Trello ─────────────────────
router.post("/signal", signalLimiter, async (req, res) => {
  const { cat, desc, lat, lon, photoB64, type } = req.body || {};

  const mapsLink = (lat && lon)
    ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=18`
    : null;

  const isBug     = (type === "bug" || (cat || "").startsWith("[BUG]"));
  const isContact = (type === "contact" || (cat || "").startsWith("[Demande]"));
  const signalType = isBug ? "bug" : isContact ? "demande" : "signalement";

  const { notifyToken, sub } = req.body || {};
  const signal = {
    id: Date.now(),
    type: signalType,
    cat: cat || "Non précisée",
    desc: desc || "",
    lat,
    lon,
    mapsLink,
    hasPhoto: !!photoB64,
    date: new Date().toLocaleString("fr-FR"),
    dateISO: new Date().toISOString(),
    ...(notifyToken ? { notifyToken } : {})
  };

  // Stockage Redis
  const signals = await readSignals();
  signals.unshift(signal);
  if (signals.length > 100) signals.splice(100);
  await writeSignals(signals);
  if (notifyToken) {
    registerNotifyToken(notifyToken, "signal", signal.id, sub || null).catch(() => {});
  }
  console.log(`🚨 Signalement stocké #${signal.id}: ${signalType} — ${signal.cat}`);

  // Envoi Trello
  try {
    let cardName;

    if (signalType === "bug") {
      cardName = `[BUG] ${String(cat || "").replace("[BUG]", "").trim() || "Non précisé"}`;
    } else if (signalType === "demande") {
      cardName = `[Demande] ${String(desc || "").split("\
")[0].substring(0, 80) || "Contact mairie"}`;
    } else {
      cardName = `[Signalement] ${cat || "Non précisé"}`;
    }

    const mapsLine = mapsLink ? `\
\
📍 Voir sur la carte : ${mapsLink}` : "";
    const dateLine = `\
\
📅 ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}`;
    const typeLine = `\
🏷️ Type : ${signalType}`;
    const cardDesc = `${desc || "Aucune description."}${typeLine}${mapsLine}${dateLine}`;

    await createTrelloCard(signalType, cardName, cardDesc, photoB64 || null, notifyToken || null);
  } catch (trelloErr) {
    console.warn("⚠️ Trello échec (signal stocké Redis quand même):", trelloErr.message);
  }

  res.json({ success: true });
});

router.get("/signalements", async (req, res) => {
  const signals = await readSignals();
  res.json({ signalements: signals, count: signals.length });
});

router.get('/api/signalements', async (req, res) => {
  try { res.json(await _fetchTrelloSignalements()); }
  catch(e) {
    console.error('api/signalements:', e.message);
    res.status(502).json({ signalements: [], bugs: [], error: 'Service temporairement indisponible' });
  }
});

router.get('/api/signalements/photo/:cardId/:attachId', async (req, res) => {
  try {
    const { cardId, attachId } = req.params;
    if (!/^[a-zA-Z0-9]+$/.test(cardId) || !/^[a-zA-Z0-9]+$/.test(attachId)) return res.status(400).end();
    if (!TRELLO_KEY || !TRELLO_TOKEN) return res.status(503).end();
    let entry = _attachmentUrlMap.get(`${cardId}/${attachId}`);
    if (!entry) { await _fetchTrelloSignalements(); entry = _attachmentUrlMap.get(`${cardId}/${attachId}`); }
    if (!entry) return res.status(404).end();
    // Étape 1 : requête Trello avec OAuth, sans suivre la redirection
    const step1 = await axios.get(entry.trelloUrl, {
      responseType: 'stream',
      maxRedirects: 0,
      validateStatus: s => s < 500,
      timeout: 10000,
      headers: { Authorization: `OAuth oauth_consumer_key="${TRELLO_KEY}", oauth_token="${TRELLO_TOKEN}"` },
    });
    if (step1.status >= 300 && step1.status < 400 && step1.headers['location']) {
      // Étape 2 : récupérer le fichier depuis S3/Cloudinary (URL signée, pas d'auth)
      step1.data.resume();
      const s3Url = step1.headers['location'];
      const r = await axios.get(s3Url, { responseType: 'stream', timeout: 20000 });
      res.setHeader('Content-Type', r.headers['content-type'] || entry.mimeType);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return r.data.pipe(res);
    }
    // Trello a renvoyé l'image directement
    res.setHeader('Content-Type', step1.headers['content-type'] || entry.mimeType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    step1.data.pipe(res);
  } catch(e) { console.error('photo proxy:', e.message); res.status(502).end(); }
});

// ── Liste signalements (admin) ────────────────────────────────
router.get("/admin/signals", adminAuth, async (req, res) => {
  const signals = await readSignals();
  res.json({ signals, count: signals.length });
});

// ── Modifier le statut d'un signalement (admin) ──────────────
router.patch("/admin/signals/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body || {};
  const validStatuses = ["pending", "in_progress", "resolved"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: "Statut invalide" });
  }
  const signals = await readSignals();
  const idx = signals.findIndex(s => s.id === id);
  if (idx < 0) return res.status(404).json({ error: "Signalement non trouvé" });
  const prevStatus = signals[idx].status || "pending";
  signals[idx].status = status;
  await writeSignals(signals);
  const token = signals[idx].notifyToken;
  if (token && status !== prevStatus && SIGNAL_STATUS_PUSH[status]) {
    const msg = SIGNAL_STATUS_PUSH[status];
    sendPushToToken(token, {
      title: msg.title, body: msg.body,
      icon: "./icon-192.png", badge: "./icon-badge.png",
      tag: `signal-status-${id}`,
      data: { url: "./#signalements", open: "signalements" }
    }).catch(() => {});
  }
  res.json({ ok: true, signal: signals[idx] });
});

// ── Supprimer un signalement ──────────────────────────────────
router.delete("/admin/signals/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const signals = await readSignals();
  const filtered = signals.filter(s => s.id !== id);
  if (filtered.length === signals.length) return res.status(404).json({ error: "Signalement non trouvé" });
  await writeSignals(filtered);
  res.json({ ok: true, deleted: id });
});

module.exports = router;
