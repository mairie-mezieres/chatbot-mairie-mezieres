// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const webpush = require("./webpush");
const { redisGet, redisSetex, redisDel } = require("./redis");

const TOKEN_TTL = 365 * 24 * 3600;

function _tokenKey(token) {
  return `mat:notify:token:${token}`;
}

async function registerNotifyToken(token, type, id, sub) {
  if (!token) return;
  const existing = await redisGet(_tokenKey(token));
  const entry = {
    type,
    id: String(id),
    sub: sub || (existing && existing.sub) || null
  };
  await redisSetex(_tokenKey(token), TOKEN_TTL, entry);
}

async function updateNotifyTokenSub(token, sub) {
  if (!token || !sub) return false;
  const entry = await redisGet(_tokenKey(token));
  if (!entry) return false;
  entry.sub = sub;
  await redisSetex(_tokenKey(token), TOKEN_TTL, entry);
  return true;
}

async function sendPushToToken(token, payload) {
  if (!token) return { skipped: true, reason: "no token" };
  const entry = await redisGet(_tokenKey(token));
  if (!entry) return { skipped: true, reason: "token not found" };
  if (!entry.sub) return { skipped: true, reason: "no subscription" };

  try {
    await webpush.sendNotification(entry.sub, JSON.stringify(payload), { urgency: 'normal', TTL: 86400 });
    await redisSetex(_tokenKey(token), TOKEN_TTL, entry);
    return { sent: true };
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      entry.sub = null;
      await redisSetex(_tokenKey(token), TOKEN_TTL, entry).catch(() => {});
      return { skipped: true, reason: "subscription expired" };
    }
    console.warn(`Push notify token ${token.substring(0, 8)}…:`, e.message);
    return { skipped: true, reason: e.message };
  }
}

// Messages de notification selon le statut d'un signalement.
const SIGNAL_STATUS_PUSH = {
  in_progress: { title: "🔵 Votre signalement est en cours de traitement", body: "La mairie a pris en compte votre signalement." },
  resolved:    { title: "✅ Votre signalement a été résolu", body: "La mairie a traité votre signalement. Merci pour votre contribution !" }
};

// Helper partagé (admin PATCH + webhook Trello) : envoie le push de
// changement de statut au propriétaire du signalement via son token.
async function sendSignalStatusPush(token, status, tagId) {
  const msg = SIGNAL_STATUS_PUSH[status];
  if (!token || !msg) return { skipped: true, reason: "no token or status sans message" };
  return sendPushToToken(token, {
    title: msg.title,
    body: msg.body,
    icon: "./icon-192.png",
    badge: "./icon-badge.png",
    tag: `signal-status-${tagId}`,
    data: { url: "./#signalements", open: "signalements" }
  });
}

const DEMANDE_STATUS_PUSH = {
  in_progress: { title: "🔵 Votre demande est en cours de traitement", body: "La mairie a pris en compte votre demande." },
  resolved:    { title: "✅ Votre demande a été traitée", body: "La mairie a traité votre demande. Merci !" }
};

async function sendDemandeStatusPush(token, status, tagId) {
  const msg = DEMANDE_STATUS_PUSH[status];
  if (!token || !msg) return { skipped: true, reason: "no token or status sans message" };
  return sendPushToToken(token, {
    title: msg.title,
    body: msg.body,
    icon: "./icon-192.png",
    badge: "./icon-badge.png",
    tag: `demande-status-${tagId}`,
    data: { url: "./#contact", open: "contact" }
  });
}

async function sendDemandeCommentPush(token, commentText, tagId) {
  if (!token) return { skipped: true, reason: "no token" };
  const preview = (commentText || "").substring(0, 120);
  return sendPushToToken(token, {
    title: "💬 Nouveau message de la mairie",
    body: preview || "La mairie a répondu à votre demande.",
    icon: "./icon-192.png",
    badge: "./icon-badge.png",
    tag: `demande-comment-${tagId}`,
    data: { url: "./#contact", open: "contact" }
  });
}

module.exports = {
  registerNotifyToken, updateNotifyTokenSub, sendPushToToken,
  sendSignalStatusPush, SIGNAL_STATUS_PUSH,
  sendDemandeStatusPush, sendDemandeCommentPush, DEMANDE_STATUS_PUSH
};
