// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { VERIFY_TOKEN } = require("../config");
const { readSeenPosts, writeSeenPosts, readNews, writeNews, readSubs, writeSubs, recordPushHistory } = require("../lib/store");
const webpush = require("../lib/webpush");

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
            const postKey =
              change.value.post_id ||
              change.value.comment_id ||
              change.value.sender_id ||
              (msg.replace(/\s+/g, " ").trim() + "|" + (photo || ""));

            console.log("📰 Publication #MAT détectée", postKey);
            await handleFacebookPublication(msg, photo, postKey);
          }
        }
      }
    }
  }
});

// ── Publication Facebook → stockage + push + anti-doublon ───
async function handleFacebookPublication(msg, photoUrl, postKey) {
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

  const actu = {
    id: Date.now(),
    title,
    description,                        // NOUVEAU — texte complet après la 1ère ligne
    date: new Date().toLocaleDateString("fr-FR"),
    dateISO: new Date().toISOString().slice(0, 10),
    photo: photoUrl || null,
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
    image: photoUrl || undefined,
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
