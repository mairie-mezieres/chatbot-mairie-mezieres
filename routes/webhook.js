// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const { VERIFY_TOKEN } = require("../config");
const { readSeenPosts, writeSeenPosts, readNews, writeNews } = require("../lib/store");
const { sendActuPush } = require("../lib/actu");
const { fetchFacebookFullPicture } = require("../lib/facebook");
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
  if (!appSecret) return res.sendStatus(503); // fail closed si secret manquant
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return res.sendStatus(403);
  const crypto = require('crypto');
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody || Buffer.from('')).digest('hex');
  const sigBuf = Buffer.from(sig); const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return res.sendStatus(403);
  res.status(200).send("EVENT_RECEIVED");
  const body = req.body;

  if (body.object === "page") {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === "feed" && change.value?.message) {
          const msg = change.value.message;
          const photo = change.value.photo || null;
          const postId = change.value.post_id || null;
          if (/#MAT\b/i.test(msg)) {
            const postKey =
              change.value.post_id ||
              change.value.comment_id ||
              change.value.sender_id ||
              (msg.replace(/\s+/g, " ").trim() + "|" + (photo || ""));

            console.log("📰 Publication #MAT détectée", postKey);
            await handleFacebookPublication(msg, photo, postKey, postId);
          }
        }
      }
    }
  }
});

// ── Récupérer et persister l'image du post Facebook ──────────
async function resolvePostImage(postId, fallbackPhoto) {
  // Essai 1 : Graph API pour obtenir la full_picture
  let fullPicture = null;
  if (postId) {
    fullPicture = await fetchFacebookFullPicture(postId);
  }
  const sourceUrl = fullPicture || fallbackPhoto;
  if (!sourceUrl) return { photoUrl: null, photoPublicId: null };

  // Essai 2 : upload Cloudinary si configuré
  if (CLOUDINARY_ENABLED) {
    try {
      const imgResp = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 10000 });
      const mimeType = (imgResp.headers['content-type'] || 'image/jpeg').split(';')[0];
      const base64 = `data:${mimeType};base64,` + Buffer.from(imgResp.data).toString('base64');
      const cloudResult = await uploadActuImageToCloudinary(base64);
      if (cloudResult?.secure_url) {
        return { photoUrl: cloudResult.secure_url, photoPublicId: cloudResult.public_id };
      }
    } catch (e) {
      console.warn("⚠️ Upload Cloudinary image FB échoué, fallback URL directe:", e.message);
    }
  }

  // Fallback : URL directe (full_picture ou change.value.photo)
  return { photoUrl: sourceUrl, photoPublicId: null };
}

// ── Publication Facebook → stockage + push + anti-doublon ────
async function handleFacebookPublication(msg, photoUrl, postKey, postId) {
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
    (a.photo || null) === (photoUrl || null)
  );

  if (alreadyInNews) {
    console.log(`⏭️ Actualité déjà présente: "${title}"`);
    if (postKey) {
      seen[postKey] = Date.now();
      await writeSeenPosts(seen);
    }
    return { duplicate: true };
  }

  // Résolution de l'image (Graph API → Cloudinary ou URL directe)
  const { photoUrl: finalPhotoUrl, photoPublicId } = await resolvePostImage(postId, photoUrl);

  const actu = {
    id: Date.now(),
    title,
    description,
    date: new Date().toLocaleDateString("fr-FR"),
    dateISO: new Date().toISOString().slice(0, 10),
    photo: finalPhotoUrl || null,
    ...(photoPublicId ? { photoPublicId } : {}),
    source: "facebook"
  };

  actus.unshift(actu);
  if (actus.length > 30) actus.splice(30);
  await writeNews(actus);
  console.log(`💾 Actu FB stockée: "${title}" (photo: ${finalPhotoUrl ? 'oui' : 'non'})`);

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
