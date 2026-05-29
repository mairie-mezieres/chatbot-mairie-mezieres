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
    await webpush.sendNotification(entry.sub, JSON.stringify(payload));
    await redisSetex(_tokenKey(token), TOKEN_TTL, entry);
    return { sent: true };
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      await redisDel(_tokenKey(token));
      return { skipped: true, reason: "subscription expired" };
    }
    console.warn(`Push notify token ${token.substring(0, 8)}…:`, e.message);
    return { skipped: true, reason: e.message };
  }
}

module.exports = { registerNotifyToken, updateNotifyTokenSub, sendPushToToken };
