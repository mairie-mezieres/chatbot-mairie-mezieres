// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const { VERIFY_TOKEN } = require("../config");
const { readSeenPosts, writeSeenPosts, readNews, writeNews } = require("../lib/store");
const { sendActuPush, MAX_ACTU_PHOTOS } = require("../lib/actu");
const { fetchFacebookPostImages } = require("../lib/facebook");
const { uploadActuImageToCloudinary, CLOUDINARY_ENABLED } = require("../lib/cloudinary");

// ── Webhook Facebook (feed only) ──────────────────────────────
router.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    console.log("✅ Webhook vérifié");
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

router.post("/webhook", async (req, res) => {
  // Vérification HMAC-SHA256 Facebook
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appSecret) {
    console.error("❌ Webhook Facebook : FACEBOOK_APP_SECRET manquant — rejet 503");
    return res.sendStatus(503);
  }
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) {
    console.warn("⚠️ Webhook Facebook : en-tête x-hub-signature-256 absent — rejet 403");
    return res.sendStatus(403);
  }
  const crypto = require('crypto');
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody || Buffer.from('')).digest('hex');
  const sigBuf = Buffer.from(sig); const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.warn("⚠️ Webhook Facebook : signature HMAC invalide — rejet 403");
    return res.sendStatus(403);
  }
  res.status(200).send("EVENT_RECEIVED");
  const body = req.body;

  if (body.object === "page") {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "feed") continue;
        const msg = change.value?.message || null;
        const item = change.value?.item || "inconnu";
        if (!msg) {
          console.log(`📡 Webhook Facebook : feed reçu sans message (item=${item}) — ignoré`);
          continue;
        }
        if (!/#MAT\b/i.test(msg)) {
          console.log(`📡 Webhook Facebook : feed reçu sans #MAT (item=${item}) — ignoré`);
          continue;
        }
        // Un post à UNE photo porte `photo` (une chaîne) ; un post à PLUSIEURS
        // porte `photos` (un tableau d'URL) et pas de `photo`. Lire le seul
        // `photo`, c'était n'avoir aucune image du tout sur un post multiple
        // quand la Graph API ne répondait pas.
        const photos = normalizeWebhookPhotos(change.value);
        const postId = change.value.post_id || null;
        const postKey =
          change.value.post_id ||
          change.value.comment_id ||
          change.value.sender_id ||
          (msg.replace(/\s+/g, " ").trim() + "|" + (photos[0] || ""));

        console.log(`📰 Publication #MAT détectée ${postKey} (${photos.length} image(s) annoncée(s))`);
        await handleFacebookPublication(msg, photos, postKey, postId);
      }
    }
  }
});

// ── Images annoncées par le webhook lui-même ─────────────────
// `photos` (tableau) pour un post multi-images, `photo` (chaîne) pour un post à
// une image. Les deux ne sont pas censés coexister ; on les concatène quand
// même, l'ordre restant celui de Facebook (la couverture en tête).
function normalizeWebhookPhotos(value) {
  const brut = []
    .concat(Array.isArray(value?.photos) ? value.photos : [])
    .concat(value?.photo ? [value.photo] : []);
  const out = [];
  for (const u of brut) {
    if (typeof u !== "string") continue;
    const s = u.trim();
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= MAX_ACTU_PHOTOS) break;
  }
  return out;
}

// ── Récupérer et persister les images du post Facebook ───────
//
// Deux sources décrivent les mêmes images, et on ne les FUSIONNE jamais : une
// même photo n'a pas la même URL dans le corps du webhook et dans la Graph API
// (deux hôtes CDN, deux jeux de paramètres signés). Les concaténer publierait
// chaque image en double sans qu'aucune comparaison de chaînes ne s'en aperçoive.
// On choisit donc CELLE QUI EN DÉCRIT LE PLUS, la Graph API l'emportant à
// égalité (URL de meilleure définition, et seule source quand le corps du
// webhook n'annonce rien). La Graph API rend un tableau vide sans
// `PAGE_ACCESS_TOKEN` : le corps du webhook reste alors le seul recours.
async function resolvePostImages(postId, fallbackPhotos) {
  const parGraph = await fetchFacebookPostImages(postId);
  const parWebhook = Array.isArray(fallbackPhotos) ? fallbackPhotos : [];
  const sources = (parGraph.length >= parWebhook.length ? parGraph : parWebhook)
    .slice(0, MAX_ACTU_PHOTOS);
  if (!sources.length) return [];

  const photos = [];
  for (const sourceUrl of sources) {
    photos.push(await persistImage(sourceUrl));
  }
  return photos;
}

// Une image ratée n'annule pas les autres : elle retombe sur l'URL Facebook
// directe, exactement comme avant la v4.115 quand il n'y en avait qu'une.
async function persistImage(sourceUrl) {
  if (CLOUDINARY_ENABLED) {
    try {
      const imgResp = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 10000 });
      const mimeType = (imgResp.headers['content-type'] || 'image/jpeg').split(';')[0];
      const base64 = `data:${mimeType};base64,` + Buffer.from(imgResp.data).toString('base64');
      const cloudResult = await uploadActuImageToCloudinary(base64);
      if (cloudResult?.secure_url) {
        return { url: cloudResult.secure_url, publicId: cloudResult.public_id || null };
      }
    } catch (e) {
      console.warn("⚠️ Upload Cloudinary image FB échoué, fallback URL directe:", e.message);
    }
  }
  return { url: sourceUrl, publicId: null };
}

// ── Publication Facebook → stockage + push + anti-doublon ────
async function handleFacebookPublication(msg, photoUrls, postKey, postId) {
  const seen = await readSeenPosts();

  if (postKey && seen[postKey]) {
    console.log(`⏭️ Publication déjà traitée: ${postKey}`);
    return { duplicate: true };
  }

  // Texte complet du post, sans le hashtag
  const fullText = (msg || "").replace(/#(MAT\b|app-mezieres)/gi, "").trim();

  // Découpage propre : 1ère ligne (non vide) = titre, reste = description
  const lines = fullText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const title = (lines[0] || "Actualité").substring(0, 150);
  const description = lines.length > 1 ? lines.slice(1).join("\n").substring(0, 3000) : null;

  const actus = await readNews();

  // Détection de doublon : même titre + même photo
  const alreadyInNews = actus.some(a =>
    (a.title || "").trim() === title &&
    (a.photo || null) === (photoUrls[0] || null)
  );

  if (alreadyInNews) {
    console.log(`⏭️ Actualité déjà présente: "${title}"`);
    if (postKey) {
      seen[postKey] = Date.now();
      await writeSeenPosts(seen);
    }
    return { duplicate: true };
  }

  // Résolution des images (Graph API / corps du webhook → Cloudinary ou URL directe)
  const photos = await resolvePostImages(postId, photoUrls);
  const finalPhotoUrl = photos.length ? photos[0].url : null;
  const photoPublicId = photos.length ? photos[0].publicId : null;

  const actu = {
    id: Date.now(),
    title,
    description,
    date: new Date().toLocaleDateString("fr-FR"),
    dateISO: new Date().toISOString().slice(0, 10),
    // `photo` reste LA COUVERTURE, et reste seule à être lue par le push, la
    // vignette bureau et la carte « prochaine manifestation » : `photos` s'y
    // ajoute, ne la remplace pas (ADR-0039).
    photo: finalPhotoUrl,
    ...(photoPublicId ? { photoPublicId } : {}),
    ...(photos.length ? { photos } : {}),
    source: "facebook"
  };

  actus.unshift(actu);
  if (actus.length > 30) actus.splice(30);
  await writeNews(actus);
  console.log(`💾 Actu FB stockée: "${title}" (${photos.length} photo(s))`);

  if (postKey) {
    seen[postKey] = Date.now();
    const entries = Object.entries(seen)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 500);
    await writeSeenPosts(Object.fromEntries(entries));
  }

  // Envoi notification push
  const pushResult = await sendActuPush(title, description, finalPhotoUrl, actu.id);
  console.log(`📱 Push: ${pushResult.sent}/${pushResult.total} envoyés`);

  return { duplicate: false };
}

module.exports = router;
// Exportés pour les tests (aucun appel réseau : voir test/webhook-photos.test.js).
module.exports.normalizeWebhookPhotos = normalizeWebhookPhotos;
module.exports.resolvePostImages = resolvePostImages;
