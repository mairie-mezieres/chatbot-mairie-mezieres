// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const axios = require("axios");
const { PAGE_ACCESS_TOKEN } = require("../config");
const { resolveFacebookPageId } = require("./facebook");
const { readSubs, writeSubs, purgeEndpointsEverywhere, recordPushHistory } = require("./store");
const webpush = require("./webpush");

// ── Publier une actu sur Facebook (sans #MAT) ───────────────
// imageBase64 : photo en data URL (upload multipart). À défaut, imageUrl permet
// de publier la photo par URL (utilisé par les publications programmées : l'image
// est hébergée sur Cloudinary à la programmation, postée par URL à l'heure dite).
async function publishActuToFacebook(title, description, imageBase64, eventDate, eventLocation, imageUrl) {
  const pageId = await resolveFacebookPageId();
  if (!pageId || !PAGE_ACCESS_TOKEN) {
    throw new Error("Page Facebook ou token manquant");
  }

  const lines = [];
  lines.push(`📢 ${String(title || '').trim()}`);
  if (description) {
    const cleaned = String(description)
      .replace(/\r/g, '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .join('\n\n')
      .substring(0, 2200);
    if (cleaned) lines.push(cleaned);
  }
  if (eventDate) {
    const d = new Date(eventDate);
    const dateStr = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const hasTime = /T\d{2}:\d{2}/.test(eventDate);
    const timeStr = hasTime ? ` à ${d.getHours().toString().padStart(2,'0')}h${d.getMinutes().toString().padStart(2,'0')}` : "";
    lines.push(`📅 ${dateStr}${timeStr}`);
    if (eventLocation) lines.push(`📍 ${String(eventLocation).trim()}`);
  }
  const message = lines.join('\n\n').substring(0, 2800);

  const postTextOnly = async () => {
    const r = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/feed`, {
      message,
      access_token: PAGE_ACCESS_TOKEN
    });
    return { ok: true, mode: 'feed', post_id: r.data.id, fallbackUsed: false };
  };

  try {
    if (imageBase64) {
      try {
        const imageBuffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ""), "base64");
        const FormData = require("form-data");
        const form = new FormData();
        form.append("source", imageBuffer, { filename: "photo.jpg", contentType: "image/jpeg" });
        form.append("message", message);
        form.append("access_token", PAGE_ACCESS_TOKEN);
        const r = await axios.post(
          `https://graph.facebook.com/v19.0/${pageId}/photos`,
          form,
          { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity }
        );
        return {
          ok: true,
          mode: 'photo',
          post_id: r.data.post_id || r.data.id,
          photo_id: r.data.id,
          photo_url: `https://graph.facebook.com/${r.data.id}/picture`,
          fallbackUsed: false
        };
      } catch (photoErr) {
        console.warn('⚠️ Publication photo Facebook échouée, fallback texte:', photoErr.response?.data || photoErr.message);
        const textOnly = await postTextOnly();
        return { ...textOnly, fallbackUsed: true, fallbackReason: photoErr.response?.data?.error?.message || photoErr.message };
      }
    } else if (imageUrl) {
      try {
        const r = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
          url: imageUrl,
          message,
          access_token: PAGE_ACCESS_TOKEN
        });
        return {
          ok: true,
          mode: 'photo',
          post_id: r.data.post_id || r.data.id,
          photo_id: r.data.id,
          photo_url: `https://graph.facebook.com/${r.data.id}/picture`,
          fallbackUsed: false
        };
      } catch (photoErr) {
        console.warn('⚠️ Publication photo (URL) Facebook échouée, fallback texte:', photoErr.response?.data || photoErr.message);
        const textOnly = await postTextOnly();
        return { ...textOnly, fallbackUsed: true, fallbackReason: photoErr.response?.data?.error?.message || photoErr.message };
      }
    }
    return await postTextOnly();
  } catch (e) {
    console.error("❌ publishActuToFacebook:", e.response?.data || e.message);
    throw new Error(e.response?.data?.error?.message || e.message);
  }
}

// ── Payload push pour une actu ────────────────────────────────
function buildActuPushPayload(title, description, photoUrl, actuId) {
  const safeId = actuId != null ? String(actuId) : "";
  const detailHash = safeId ? `./#actu=${encodeURIComponent(safeId)}` : "./#notifs";

  return JSON.stringify({
    title: `MAT — ${String(title || "").substring(0, 60)}`,
    body: String(description || title || "").substring(0, 150),
    icon: "./icon-192.png",
    badge: "./icon-badge.png",
    image: photoUrl || undefined,
    actions: [{ action: "detail", title: "Détail" }],
    data: {
      url: detailHash,
      listUrl: "./#notifs",
      actuId: safeId || null,
      open: safeId ? "actu" : "notifs"
    }
  });
}

// ── Envoyer notification push pour une actu ──────────────────
async function sendActuPush(title, description, photoUrl, actuId) {
  const subs = await readSubs();
  if (!subs.length) return { sent: 0, failed: 0, total: 0 };

  const payload = buildActuPushPayload(title, description, photoUrl, actuId);

  let sent = 0, failed = 0;
  const dead = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high', TTL: 86400 });
      sent++;
    } catch (e) {
      failed++;
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
    }
  }
  if (dead.length) {
    const alive = subs.filter(s => !dead.includes(s.endpoint));
    await writeSubs(alive);
    purgeEndpointsEverywhere(dead).catch(() => {});
  }
  await recordPushHistory({ type: 'actu', title: (title || '').substring(0, 80), sent, total: subs.length, dead: dead.length });
  return { sent, failed, total: subs.length };
}

module.exports = { publishActuToFacebook, buildActuPushPayload, sendActuPush };
