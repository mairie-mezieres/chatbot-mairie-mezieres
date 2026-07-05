// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { readSignals, writeSignals } = require("../lib/store");
const { adminAuth } = require("../lib/middleware");
const { TRELLO_KEY, TRELLO_TOKEN, TRELLO_LIST_ID_SIG, TRELLO_LIST_ID_BUG, TRELLO_NOTIFY, OPEN_METEO_LAT, OPEN_METEO_LON } = require("../config");
const { registerNotifyToken, sendSignalStatusPush, sendDemandeStatusPush } = require("../lib/push-notify");
const { trelloStatusFromListName } = require("../lib/trello-status");
const { capStr, geoPointNear, inEnum } = require("../lib/validate");

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
// Cache « riche » (desc brute conservée), partagé entre vue citoyen et vue
// admin. TTL court : Trello est la source de vérité, on veut peu de latence.
const SIG_CACHE_TTL = 60 * 1000;
let _sigRichCache = null, _sigRichCacheAt = 0;

function _invalidateSigCache() { _sigRichCache = null; _sigRichCacheAt = 0; }

// Récupère les cartes Trello et construit des items « riches » (desc brute,
// matRef, coordonnées). Les vues citoyen/admin en dérivent.
async function _fetchTrelloRich() {
  if (_sigRichCache && Date.now() - _sigRichCacheAt < SIG_CACHE_TTL) return _sigRichCache;
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
    const descRaw = (card.desc || '').replace(/\nMAT-REF:\s*[a-f0-9-]{36}/gi, '').trim();
    // Coordonnées GPS extraites du lien OpenStreetMap inséré à la création.
    // geoPointNear écarte les points implausibles (Null Island 0,0, point à
    // des milliers de km…) présents dans d'anciennes cartes : pas de marqueur
    // aberrant sur la carte citoyenne, le lien reste lisible dans Trello.
    const geoMatch = (card.desc || '').match(/mlat=(-?\d+(?:\.\d+)?)&mlon=(-?\d+(?:\.\d+)?)/i);
    const { lat, lon } = geoMatch
      ? geoPointNear(parseFloat(geoMatch[1]), parseFloat(geoMatch[2]), OPEN_METEO_LAT, OPEN_METEO_LON)
      : { lat: null, lon: null };
    const rich = { id: card.id, type: isSig ? 'signalement' : 'bug', cat, descRaw, status, statusLabel, date: card.dateLastActivity, comments, photos, matRef, lat, lon };
    if (isSig) result.signalements.push(rich);
    else result.bugs.push(rich);
  }
  result.signalements.sort((a, b) => b.date.localeCompare(a.date));
  result.bugs.sort((a, b) => b.date.localeCompare(a.date));
  _sigRichCache = result; _sigRichCacheAt = Date.now();
  return result;
}

// Vue citoyen : description anonymisée, champs publics seulement.
async function _fetchTrelloSignalements() {
  const rich = await _fetchTrelloRich();
  const pub = s => ({
    id: s.id, cat: s.cat, desc: _anonymize(s.descRaw), status: s.status, statusLabel: s.statusLabel,
    date: s.date, comments: s.comments, photos: s.photos,
    ...(s.matRef ? { matRef: s.matRef } : {}),
    ...(s.lat != null && s.lon != null ? { lat: s.lat, lon: s.lon } : {})
  });
  return { signalements: rich.signalements.map(pub), bugs: rich.bugs.map(pub) };
}

// Vue admin : description brute (infos de contact visibles), id de carte Trello.
async function _fetchTrelloAdmin() {
  const rich = await _fetchTrelloRich();
  const adm = s => ({
    id: s.id, type: s.type, cat: s.cat, desc: s.descRaw, status: s.status, statusLabel: s.statusLabel,
    date: (() => { try { return new Date(s.date).toLocaleString('fr-FR'); } catch (_) { return s.date; } })(),
    hasPhoto: (s.photos || []).length > 0,
    ...(s.lat != null && s.lon != null ? { lat: s.lat, lon: s.lon, mapsLink: `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}&zoom=18` } : {})
  });
  return [...rich.signalements.map(adm), ...rich.bugs.map(adm)];
}

// ── Signalement citoyen → Redis + Trello ─────────────────────
router.post("/signal", signalLimiter, async (req, res) => {
  let { cat, desc, lat, lon, photoB64, type } = req.body || {};

  // Plafonds/validation des entrées citoyennes (cohérent avec /idee) : évite de
  // gonfler Redis (mat:signals) et l'email quotidien via un POST abusif, et
  // empêche d'injecter autre chose que des coordonnées dans le lien carte.
  cat  = capStr(cat, 200);
  desc = capStr(desc, 5000);
  // Coordonnées plausibles uniquement : bornées ET proches de la commune
  // (±55 km). Écarte les points non numériques, hors plage, et « Null Island »
  // (0,0) que certains téléphones renvoient quand la position est indisponible.
  // Tout point écarté = pas de lien carte, jamais injecté dans l'URL.
  ({ lat, lon } = geoPointNear(lat, lon, OPEN_METEO_LAT, OPEN_METEO_LON));
  const _hasGeo = lat !== null && lon !== null;

  const mapsLink = _hasGeo
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

  // Journal de soumissions (Redis) — sert uniquement aux compteurs/stats
  // (dashboard, email quotidien). La source de vérité est désormais Trello.
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
      const _nameMatch = (desc || "").match(/^Nom\/pr[eé]nom\s*:\s*(.+)/m);
      const _contactName = _nameMatch ? _nameMatch[1].trim() : null;
      if (_contactName && _contactName !== "Non précisé") {
        cardName = `[Demande] ${_contactName.substring(0, 80)}`;
      } else {
        const _msgMatch = (desc || "").match(/\n\nMessage\s*:\s*(.+)/);
        const _msgLine = _msgMatch ? _msgMatch[1].trim().substring(0, 70) : "";
        cardName = `[Demande] ${_msgLine || "Contact mairie"}`;
      }
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
    _invalidateSigCache(); // la nouvelle carte doit apparaître sans attendre le TTL
  } catch (trelloErr) {
    console.warn("⚠️ Trello échec (signal journalisé Redis quand même):", trelloErr.message);
  }

  res.json({ success: true });
});

router.get("/signalements", async (req, res) => {
  const signals = await readSignals();
  // Filtrer les champs sensibles (notifyToken = clé push privée de l'auteur)
  const pub = signals.map(({ notifyToken: _nt, ...s }) => s);
  res.json({ signalements: pub, count: pub.length });
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

// ── Liste signalements (admin) — lue depuis Trello (source de vérité) ──
router.get("/admin/signals", adminAuth, async (req, res) => {
  try {
    const signals = await _fetchTrelloAdmin();
    res.json({ signals, count: signals.length });
  } catch (e) {
    console.error('admin/signals:', e.message);
    res.status(502).json({ signals: [], count: 0, error: 'Trello temporairement indisponible' });
  }
});

// ── Modifier le statut (admin) → déplace la carte Trello ─────
router.patch("/admin/signals/:id", adminAuth, async (req, res) => {
  const cardId = req.params.id;
  const { status } = req.body || {};
  if (!inEnum(status, ["pending", "in_progress", "resolved"])) return res.status(400).json({ error: "Statut invalide" });
  if (!TRELLO_KEY || !TRELLO_TOKEN) return res.status(503).json({ error: "Trello non configuré" });
  try {
    const card = await _trelloGet(`/cards/${encodeURIComponent(cardId)}?fields=idBoard,idList,desc,name`);
    const lists = await _trelloGet(`/boards/${card.idBoard}/lists?fields=id,name&filter=open`);
    const target = lists.find(l => trelloStatusFromListName(l.name) === status);
    if (!target) return res.status(422).json({ error: `Aucune liste Trello ne correspond au statut « ${status} ». Renommez une liste (ex. « En cours », « Résolu ») ou créez-la.` });
    const curList = lists.find(l => l.id === card.idList);
    const prevStatus = curList ? trelloStatusFromListName(curList.name) : 'pending';

    if (target.id !== card.idList) {
      await axios.put(`https://api.trello.com/1/cards/${encodeURIComponent(cardId)}`, null, {
        params: { key: TRELLO_KEY, token: TRELLO_TOKEN, idList: target.id }, timeout: 10000
      });
      _invalidateSigCache();
    }
    // Push au propriétaire si le statut change réellement (token = MAT-REF)
    if (prevStatus !== status) {
      const m = (card.desc || '').match(/MAT-REF:\s*([a-f0-9-]{36})/i);
      if (m) {
        const isDemandeCard = (card.name || '').startsWith('[Demande]');
        const pushFn = isDemandeCard ? sendDemandeStatusPush : sendSignalStatusPush;
        pushFn(m[1], status, cardId).then(r => {
          console.log(`🔔 PATCH ${cardId} ${prevStatus}→${status} push:`, r);
        }).catch(() => {});
      }
    }
    res.json({ ok: true, status });
  } catch (e) {
    console.error('patch signal:', e.message);
    res.status(502).json({ error: (e.response && e.response.data) || e.message });
  }
});

// ── Supprimer un signalement (admin) → archive la carte Trello ──
router.delete("/admin/signals/:id", adminAuth, async (req, res) => {
  const cardId = req.params.id;
  if (!TRELLO_KEY || !TRELLO_TOKEN) return res.status(503).json({ error: "Trello non configuré" });
  try {
    await axios.put(`https://api.trello.com/1/cards/${encodeURIComponent(cardId)}`, null, {
      params: { key: TRELLO_KEY, token: TRELLO_TOKEN, closed: true }, timeout: 10000
    });
    _invalidateSigCache();
    res.json({ ok: true, deleted: cardId });
  } catch (e) {
    console.error('delete signal:', e.message);
    res.status(502).json({ error: (e.response && e.response.data) || e.message });
  }
});

module.exports = router;
