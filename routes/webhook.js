// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { VERIFY_TOKEN, PAGE_ACCESS_TOKEN } = require("../config");
const { readSeenPosts, writeSeenPosts, readNews, writeNews, readSubs, writeSubs, recordPushHistory } = require("../lib/store");
const webpush = require("../lib/webpush");
const { uploadActuImageUrlToCloudinary, CLOUDINARY_ENABLED } = require("../lib/cloudinary");

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
  if (sig !== expected) return res.sendStatus(403);
  res.status(200).send("EVENT_RECEIVED");
  const body = req.body;

  if (body.object === "page") {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === "feed" && change.value?.message) {
          const msg = change.value.message;
          const photo = change.value.photo || null;
          if (/#MAT\b/i.test(msg)) {
            const postId = change.value.post_id || null;
            const postKey =
              postId ||
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

// ── Récupération full_picture + upload Cloudinary ───────────
async function fetchAndHostPhoto(postId, fallbackUrl) {
  // 1. Récupérer full_picture depuis l'API Graph (meilleure résolution)
  let sourceUrl = fallbackUrl;
  if (postId && PAGE_ACCESS_TOKEN) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/${encodeURIComponent(postId)}?fields=full_picture&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const data = await res.json();
        if (data.full_picture) sourceUrl = data.full_picture;
      }
    } catch (e) {
      console.warn("⚠️ Graph API full_picture:", e.message);
    }
  }

  if (!sourceUrl) return null;

  // 2. Uploader sur Cloudinary pour héberger l'image durablement
  if (CLOUDINARY_ENABLED) {
    try {
      const result = await uploadActuImageUrlToCloudinary(sourceUrl);
      if (result?.secure_url) {
        console.log("📷 Photo hébergée sur Cloudinary:", result.secure_url);
        return result.secure_url;
      }
    } catch (e) {
      console.warn("⚠️ Upload Cloudinary:", e.message);
    }
  }

  // 3. Fallback : URL Facebook directe (temporaire)
  console.warn("⚠️ Photo non hébergée — URL Facebook temporaire utilisée");
  return sourceUrl;
}

// ── Publication Facebook → stockage + push + anti-doublon ───
async function handleFacebookPublication(msg, photoUrl, postKey, postId) {
  const seen = await readSeenPosts();

  if (postKey && seen[postKey]) {
    console.log(`⏭️ Publication déjà traitée: ${postKey}`);
    return { duplicate: true };
  }

  // Remplacer l'URL temporaire Facebook par une URL Cloudinary pérenne
  const hostedPhoto = await fetchAndHostPhoto(postId, photoUrl);

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
    (a.photo || null) === (hostedPhoto || null)
  );

  if (alreadyInNews) {
    console.log(`⏭️ Actualité déjà présente: "${title}"`);
    if (postKey) {
      seen[postKey] = Date.now();
      await writeSeenPosts(seen);
    }
    return { duplicate: true };
  }

  const actu = {
    id: Date.now(),
    title,
    description,                        // NOUVEAU — texte complet après la 1ère ligne
    date: new Date().toLocaleDateString("fr-FR"),
    dateISO: new Date().toISOString().slice(0, 10),
    photo: hostedPhoto || null,
    source: "facebook"
  };

  actus.unshift(actu);
  if (actus.length > 30) actus.splice(30);
  await writeNews(actus);
  console.log(`💾 Actu FB stockée: "${title}" (${description ? description.length + ' car. desc' : 'sans description'})`);

  if (postKey) {
    seen[postKey] = Date.now();
    const entries = Object.entries(seen)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 500);
    await writeSeenPosts(Object.fromEntries(entries));
  }

  // Envoi notification push
  const subs = await readSubs();
  console.log(`📱 Envoi push à ${subs.length} abonné(s)`);

  // Body = description (si présente) ou titre, tronqué à 200 caractères
  const notifBody = (description || title).substring(0, 200);

  const payload = JSON.stringify({
    title: `MAT — ${title.substring(0, 60)}`,
    body: notifBody,
    icon: "./icon-192.png",
    badge: "./icon-badge.png",
    image: hostedPhoto || undefined,
    data: { url: "./#notifs", listUrl: "./#notifs", open: "notifs" }
  });

  const dead = [];
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high', TTL: 86400 });
      sent++;
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
    }
  }

  if (dead.length) {
    const alive = subs.filter(s => !dead.includes(s.endpoint));
    await writeSubs(alive);
    console.log(`🗑️ ${dead.length} subscription(s) expirée(s) supprimée(s)`);
  }
  await recordPushHistory({ type: 'fb', title: title.substring(0, 80), sent, total: subs.length, dead: dead.length });

  return { duplicate: false };
}

module.exports = router;
